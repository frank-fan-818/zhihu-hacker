import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { createRedisStore } from '../src/kv.mjs';

// Real Redis protocol/Lua behind the production REST adapter. Only a random
// test namespace is touched; no FLUSHDB, configured credentials or live APIs.
export async function redisFixture(t) {
  const client=createClient({url:process.env.TEST_REDIS_URL||'redis://127.0.0.1:6398',socket:{reconnectStrategy:false,connectTimeout:2000}});
  client.on('error',()=>{});
  await client.connect();
  const prefix=`audit-${randomUUID()}:`;
  t.after(async()=>{
    const keys=await client.keys(prefix+'*');if(keys.length)await client.del(keys);
    await client.quit();
  });
  const fetcher=async(_url,options)=>{
    try{return Response.json({result:await client.sendCommand(JSON.parse(options.body))});}
    catch(e){return Response.json({error:e.message});}
  };
  const kv=()=>createRedisStore({url:'http://fixture.invalid',token:'fixture',prefix,fetcher});
  return {client,prefix,kv};
}
