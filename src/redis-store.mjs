import { AppError, hash } from './domain.mjs';

// Project JSON is stored verbatim: Redis Lua cjson re-encoding turns [] into {}.
// All document mutations are supplied as JSON and validated under the same lock.
const script = `
local action=ARGV[1]
local raw=redis.call('HGET',KEYS[1],'doc')
local p=raw and cjson.decode(raw) or nil
local function fail(code) return {code} end
local function active(op) return op.status=='queued' or op.status=='running' end
if action=='create' then
  if raw then return fail('REVISION_CONFLICT') end
  if redis.call('ZCARD',KEYS[2])>=30 then return fail('PROJECT_LIMIT') end
  redis.call('HSET',KEYS[1],'doc',ARGV[3])
  redis.call('ZADD',KEYS[2],ARGV[4],ARGV[5])
  return {'OK',ARGV[3]}
end
if not p or p.owner~=ARGV[2] then return fail('NOT_FOUND') end
if action=='get' then return {'OK',raw} end
if action=='save' then
  if p.revision~=tonumber(ARGV[4]) or (p.version or 0)~=tonumber(ARGV[5]) then return {'CONFLICT'} end
  redis.call('HSET',KEYS[1],'doc',ARGV[3])
  redis.call('ZADD',KEYS[2],ARGV[6],p.id)
  return {'OK',ARGV[3]}
end
if action=='createOp' then
  local prevId=redis.call('HGET',KEYS[1],'key:'..ARGV[4])
  if prevId then
    local prev=redis.call('HGET',KEYS[1],'op:'..prevId)
    if cjson.decode(prev).signature~=ARGV[5] then return fail('IDEMPOTENCY_CONFLICT') end
    return {'OK',prev}
  end
  if p.revision~=tonumber(ARGV[6]) then return fail('REVISION_CONFLICT') end
  if redis.call('HLEN',KEYS[1])>2000 then return fail('PROJECT_LIMIT') end
  redis.call('HSET',KEYS[1],'op:'..ARGV[7],ARGV[3],'key:'..ARGV[4],ARGV[7])
  redis.call('HSET',KEYS[3],ARGV[7],p.id)
  return {'OK',ARGV[3]}
end
if action=='byKey' then
  local oid=redis.call('HGET',KEYS[1],'key:'..ARGV[3])
  return {'OK',oid and redis.call('HGET',KEYS[1],'op:'..oid) or ''}
end
if action=='getOp' or action=='updateOp' or action=='commit' then
  local oraw=redis.call('HGET',KEYS[1],'op:'..ARGV[3])
  if not oraw then return fail('NOT_FOUND') end
  local op=cjson.decode(oraw)
  if op.owner~=ARGV[2] then return fail('NOT_FOUND') end
  if action=='getOp' then return {'OK',oraw} end
  if not active(op) then return action=='commit' and fail('CANCELLED') or {'CONFLICT'} end
  if action=='updateOp' then
    redis.call('HSET',KEYS[1],'op:'..ARGV[3],ARGV[4])
    return {'OK','true'}
  end
  if op.deadline and op.deadline<tonumber(ARGV[8]) then return fail('CANCELLED') end
  if op.project~=p.id or p.revision~=tonumber(ARGV[6]) then return fail('STALE_RESULT') end
  if (p.version or 0)~=tonumber(ARGV[7]) then return {'CONFLICT'} end
  redis.call('HSET',KEYS[1],'doc',ARGV[4],'op:'..ARGV[3],ARGV[5])
  redis.call('ZADD',KEYS[2],ARGV[8],p.id)
  return {'OK',ARGV[4]}
end
if action=='delete' then
  for _,field in ipairs(redis.call('HKEYS',KEYS[1])) do
    if string.sub(field,1,3)=='op:' then redis.call('HDEL',KEYS[3],string.sub(field,4)) end
  end
  redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],p.id)
  return {'OK','true'}
end
if action=='transfer' then
  if raw~=ARGV[3] then return {'CONFLICT'} end
  if redis.call('ZCARD',KEYS[4])>=30 then return fail('PROJECT_LIMIT') end
  local entries=cjson.decode(ARGV[5])
  local actual=redis.call('HGETALL',KEYS[1])
  for i=1,#actual,2 do
    if string.sub(actual[i],1,3)=='op:' then
      if active(cjson.decode(actual[i+1])) then return fail('BUSY') end
      if not entries[actual[i]] or entries[actual[i]][1]~=actual[i+1] then return {'CONFLICT'} end
    end
  end
  redis.call('HSET',KEYS[1],'doc',ARGV[4])
  for k,v in pairs(entries) do redis.call('HSET',KEYS[1],k,v[2]) end
  redis.call('ZREM',KEYS[2],p.id);redis.call('ZADD',KEYS[4],ARGV[6],p.id)
  return {'OK',ARGV[4]}
end
return fail('INVALID_INPUT')
`;

const messages = { NOT_FOUND:'项目或任务不存在或无法访问。', PROJECT_LIMIT:'项目数量或记录容量已达上限，请删除不需要的项目。',
  REVISION_CONFLICT:'原稿已变化，请重新加载。', IDEMPOTENCY_CONFLICT:'请求标识不能用于不同操作。', CANCELLED:'操作已结束或超过执行期限。',
  STALE_RESULT:'原稿已变化，未覆盖新稿。', BUSY:'当前草稿还有运行任务，请完成后再关联账号。' };
const encode = value => {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw)>1500000) throw new AppError('PROJECT_LIMIT','研究记录已达到单项目容量上限，请新建项目。',429);
  return raw;
};
export class RedisStore {
  constructor(kv) { if(kv.kind!=='redis'||!kv.eval)throw new AppError('KV_NOT_CONFIGURED','共享持久数据库未配置。',503); this.kv=kv;this.kind='redis'; }
  keys(project,owner) { return [`data:project:${project}`,`data:owner:${hash(owner)}`,'data:operations']; }
  async action(action,project,owner,args=[],extra=[]) {
    const result=await this.kv.eval(script,[...this.keys(project,owner),...extra],[action,owner,...args]);
    if(!Array.isArray(result))throw new AppError('KV_UNAVAILABLE','共享数据库返回无效结果。',503);
    if(result[0]==='CONFLICT')return null;
    if(result[0]!=='OK')throw new AppError(result[0],messages[result[0]]||'数据操作失败。',result[0]==='NOT_FOUND'?404:result[0]==='PROJECT_LIMIT'?429:409);
    return result[1]?JSON.parse(result[1]):null;
  }
  get(project,owner) { return this.action('get',project,owner); }
  create(p) { const next={...p,version:1,updated:new Date().toISOString()};return this.action('create',p.id,p.owner,[encode(next),Date.now(),p.id]); }
  saveIfRevision(p,baseRevision,{preserveRevision=false}={}) {
    const next={...p,revision:baseRevision+(preserveRevision?0:1),version:(p.version??0)+1,updated:new Date().toISOString()};
    return this.action('save',p.id,p.owner,[encode(next),baseRevision,p.version??0,Date.now()]);
  }
  async list(owner) {
    const ids=await this.kv.eval("return redis.call('ZREVRANGE',KEYS[1],0,29)",[`data:owner:${hash(owner)}`]);
    const rows=await Promise.all(ids.map(async id=>{try{const p=await this.get(id,owner);return {id:p.id,title:p.title,revision:p.revision,updated:p.updated};}catch(e){if(e.code==='NOT_FOUND')return null;throw e;}}));
    return rows.filter(Boolean);
  }
  delete(project,owner) { return this.action('delete',project,owner); }
  createOp(op) { return this.action('createOp',op.project,op.owner,[encode(op),hash(op.key),op.signature,op.baseRevision,op.id]); }
  async byKey(project,key,owner) {
    return this.action('byKey',project,owner,[hash(key)]);
  }
  updateOp(op) { return this.action('updateOp',op.project,op.owner,[op.id,encode(op)]).then(Boolean); }
  async getOp(id,owner) {
    const project=await this.kv.eval("return redis.call('HGET',KEYS[1],ARGV[1])",['data:operations'],[id]);
    if(!project)throw new AppError('NOT_FOUND',messages.NOT_FOUND,404);
    const op=await this.action('getOp',project,owner,[id]);
    if(['queued','running'].includes(op.status)&&op.deadline<Date.now()){
      op.status='failed';op.error={code:'INTERRUPTED',message:'操作已超过执行期限，请重试。已有原稿已保留。'};
      await this.updateOp(op);
      return this.action('getOp',project,owner,[id]);
    }
    return op;
  }
  commitResult(p,op,expectedVersion) {
    const next={...p,version:expectedVersion+1,updated:new Date().toISOString()};
    return this.action('commit',p.id,p.owner,[op.id,encode(next),encode(op),op.baseRevision,expectedVersion,Date.now()]);
  }
  async transfer(project,from,to) {
    const fields=await this.kv.eval("return redis.call('HGETALL',KEYS[1])",[`data:project:${project}`]);
    const entries=Object.fromEntries(Array.from({length:fields.length/2},(_,i)=>[fields[2*i],fields[2*i+1]]));
    if(!entries.doc||JSON.parse(entries.doc).owner!==from)throw new AppError('NOT_FOUND',messages.NOT_FOUND,404);
    const p=JSON.parse(entries.doc),ops={};
    for(const [key,raw] of Object.entries(entries))if(key.startsWith('op:'))ops[key]=[raw,encode({...JSON.parse(raw),owner:to})];
    const next={...p,owner:to,version:(p.version??0)+1};
    const result=await this.action('transfer',project,from,[entries.doc,encode(next),encode(ops),Date.now()],[`data:owner:${hash(to)}`]);
    if(!result)throw new AppError('REVISION_CONFLICT',messages.REVISION_CONFLICT,409);
    return result;
  }
  close() {}
}
