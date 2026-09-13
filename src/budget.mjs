import { AppError, hash } from './domain.mjs';

const script=`
for i,key in ipairs(KEYS) do
  if tonumber(redis.call('GET',key) or '0')>=tonumber(ARGV[i]) then return 0 end
end
for i,key in ipairs(KEYS) do
  if redis.call('INCR',key)==1 then redis.call('EXPIRE',key,3600) end
end
return 1`;
const positive=(v,fallback)=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):fallback;
export function createBudget(kv,env={}) {
  const memory=new Map();
  return {async consume(owner,ip,kind='paid'){
    const limits=kind==='paid'?[positive(env.GLOBAL_HOURLY_LIMIT,200),positive(env.IP_HOURLY_LIMIT,20),30]:[1000,60,60];
    const bucket=Math.floor(Date.now()/3600000);
    const keys=[`budget:${kind}:${bucket}:global`,`budget:${kind}:${bucket}:ip:${hash(ip)}`,`budget:${kind}:${bucket}:owner:${hash(owner)}`];
    let allowed;
    if(kv.kind==='redis')allowed=await kv.eval(script,keys,limits);
    else {
      for(const [key,v] of memory)if(v.bucket!==bucket)memory.delete(key);
      allowed=keys.every((key,i)=>(memory.get(key)?.count||0)<limits[i]);
      if(allowed)for(const key of keys)memory.set(key,{count:(memory.get(key)?.count||0)+1,bucket});
    }
    if(!allowed)throw new AppError('RATE_LIMIT','当前访问或服务额度已达上限，请稍后再试。',429);
  }};
}
