import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisStore } from '../src/redis-store.mjs';
import { Service } from '../src/service.mjs';
import { OAuth } from '../src/oauth.mjs';
import { createBudget } from '../src/budget.mjs';
import { redisFixture } from './redis-helper.mjs';

const enabled=Boolean(process.env.TEST_REDIS_URL);
const text='远程办公一定能提高所有人的工作效率。具体任务类型与个人差异仍值得认真讨论。';
const providers={status:{model:false,zhihu:false}};
async function setup(t){const f=await redisFixture(t),a=new RedisStore(f.kv()),b=new RedisStore(f.kv());return {...f,a,b,service:new Service(a,providers)};}
async function done(store,op){for(let i=0;i<200;i++){const v=await store.getOp(op.id,op.owner);if(!['queued','running'].includes(v.status))return v;await new Promise(r=>setTimeout(r,5));}throw Error('timeout');}

test('real Redis persists documents across store instances, CAS protects edits and arrays remain arrays',{skip:!enabled},async t=>{
  const {a,b,service}=await setup(t);const p=await service.create('o',text);
  assert.deepEqual(await b.get(p.id,'o'),p);
  const x=await b.get(p.id,'o');assert.ok(Array.isArray(x.sources));
  const writes=await Promise.all([a.saveIfRevision({...p,text:text+'甲'},1),b.saveIfRevision({...x,text:text+'乙'},1)]);
  assert.equal(writes.filter(Boolean).length,1);assert.equal((await b.get(p.id,'o')).revision,2);
  await assert.rejects(()=>b.get(p.id,'stranger'),e=>e.code==='NOT_FOUND');
});
test('real Redis operation completion, idempotency, transfer and deletion are coherent',{skip:!enabled},async t=>{
  const {a,b,service}=await setup(t);const p=await service.create('o',text);
  const args={type:'quick_check',key:'unique-key',revision:1};
  const [x,y]=await Promise.all([service.start('o',p.id,args),new Service(b,providers).start('o',p.id,args)]);
  assert.equal(x.id,y.id);assert.equal((await done(b,x)).status,'succeeded');
  assert.equal((await b.get(p.id,'o')).findings.length,1);
  await b.transfer(p.id,'o','account');assert.equal((await a.getOp(x.id,'account')).status,'succeeded');
  await assert.rejects(()=>a.get(p.id,'o'),e=>e.code==='NOT_FOUND');
  assert.equal((await a.list('account')).length,1);
  await b.delete(p.id,'account');await assert.rejects(()=>a.getOp(x.id,'account'),e=>e.code==='NOT_FOUND');
  assert.equal((await a.list('account')).length,0);
});
test('real Redis rejects late commit after another instance cancels or deletes',{skip:!enabled},async t=>{
  const {a,b,service}=await setup(t);const p=await service.create('o',text);
  const op={id:'op',owner:'o',project:p.id,key:'key',signature:'sig',baseRevision:1,status:'running',deadline:Date.now()+60000};
  await a.createOp(op);await b.updateOp({...op,status:'cancelled'});
  await assert.rejects(()=>a.commitResult(p,{...op,status:'succeeded'},1),e=>e.code==='CANCELLED');
  await b.delete(p.id,'o');await assert.rejects(()=>a.commitResult(p,{...op,status:'succeeded'},1),e=>e.code==='NOT_FOUND');
});
test('real Redis shared global and IP budgets survive client and cookie changes',{skip:!enabled},async t=>{
  const {kv}=await setup(t);const a=createBudget(kv(),{GLOBAL_HOURLY_LIMIT:3,IP_HOURLY_LIMIT:2}),b=createBudget(kv(),{GLOBAL_HOURLY_LIMIT:3,IP_HOURLY_LIMIT:2});
  await a.consume('owner1','ip1');await b.consume('owner2','ip1');
  await assert.rejects(()=>a.consume('owner3','ip1'),e=>e.code==='RATE_LIMIT');
  await b.consume('owner3','ip2');await assert.rejects(()=>a.consume('owner4','ip3'),e=>e.code==='RATE_LIMIT');
});
test('real Redis OAuth state claim and logout invalidation are atomic',{skip:!enabled},async t=>{
  const {kv}=await setup(t);
  const env={APP_ORIGIN:'https://audit.example',ZHIHU_OAUTH_APP_ID:'fixture',ZHIHU_OAUTH_APP_KEY:'fixture',ZHIHU_OAUTH_REDIRECT_URI:'https://audit.example/auth/zhihu/callback'};
  const exchange=async url=>Response.json(url.endsWith('access_token')?{access_token:'fixture',expires_in:3600}:{hash_id:'fixture'});
  const a=new OAuth(env,exchange,Date.now,kv()),b=new OAuth(env,exchange,Date.now,kv());
  const url=new URL(await a.start('cookie')),params=new URLSearchParams({state:url.searchParams.get('state'),authorization_code:'fixture'});
  const out=await Promise.allSettled([a.finish('cookie',params),b.finish('cookie',params)]);
  assert.equal(out.filter(x=>x.status==='fulfilled').length,1);
  const result=out.find(x=>x.status==='fulfilled').value;assert.ok(await b.session(result.cookie));
  await a.logout('cookie');assert.equal(await b.session(result.cookie),null);
});

test('real Redis expires abandoned tasks and rejects their late completion',{skip:!enabled},async t=>{
  const {a,b,service}=await setup(t);const p=await service.create('o',text);
  const op={id:'expired',owner:'o',project:p.id,key:'expired',signature:'sig',baseRevision:1,status:'running',deadline:Date.now()-1};
  await a.createOp(op);
  assert.equal((await b.getOp(op.id,'o')).error.code,'INTERRUPTED');
  await assert.rejects(()=>a.commitResult(p,{...op,status:'succeeded'},1),e=>e.code==='CANCELLED');
  assert.equal((await a.get(p.id,'o')).version,1);
});

test('real Redis enforces project cap atomically and rejects transferred-owner idempotency lookup',{skip:!enabled},async t=>{
  const {a,b,service}=await setup(t);
  const outcomes=await Promise.allSettled(Array.from({length:31},()=>service.create('o',text)));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,30);
  assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'PROJECT_LIMIT');
  const p=outcomes[0].value;await b.transfer(p.id,'o','account');
  await assert.rejects(()=>a.byKey(p.id,'some-key','o'),e=>e.code==='NOT_FOUND');
});
