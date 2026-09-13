import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OAuth } from '../src/oauth.mjs';
import { createMemoryStore, createRedisStore } from '../src/kv.mjs';
import { diagnose } from '../src/config.mjs';
import { createProviders } from '../src/providers.mjs';
import { Store } from '../src/store.mjs';
import { hash } from '../src/domain.mjs';
import { createApp } from '../src/server.mjs';
const env={ZHIHU_OAUTH_APP_ID:'test-id',ZHIHU_OAUTH_APP_KEY:'test-secret',ZHIHU_OAUTH_REDIRECT_URI:'https://test.example/auth/zhihu/callback',APP_ORIGIN:'https://test.example'};
const response=x=>new Response(JSON.stringify(x));
const params=url=>new URLSearchParams({state:new URL(url).searchParams.get('state'),authorization_code:'test-code'});
test('configuration reports missing parts without revealing secrets',()=>{
  const d=diagnose({...env,MODEL_API_KEY:'never-display'});assert.equal(d.oauth,true);assert.equal(d.model,false);assert.ok(d.issues.length);assert.equal(JSON.stringify(d).includes('never-display'),false);
  assert.equal(diagnose({...env,ZHIHU_OAUTH_REDIRECT_URI:'https://other.example/auth/zhihu/callback'}).oauth,false);
});
test('OAuth state is session-bound, expires, and cannot replay',async()=>{
  let now=0,calls=0;const o=new OAuth(env,async()=>{calls++;return response({});},()=>now);
  const p=params(await o.start('cookie-a'));await assert.rejects(o.finish('cookie-b',p),/不匹配/);assert.equal(calls,0);
  now=300001;await assert.rejects(o.finish('cookie-a',p),/失效/);assert.equal(calls,0);
  const fresh=params(await o.start('cookie-a'));await assert.rejects(o.finish('cookie-a',fresh),/令牌/);assert.equal(calls,1);
  await assert.rejects(o.finish('cookie-a',fresh),/失效/);assert.equal(calls,1);
});
test('OAuth exchanges exact contract, keeps int64 identity, and rotates app cookie',async()=>{
  const calls=[];let now=0;
  const o=new OAuth(env,async(url,opts)=>{calls.push({url,opts});return calls.length===1?response({access_token:'private-token',expires_in:3600}):new Response('{"uid":969570047710216201,"fullname":"测试用户","email":"unused"}');},()=>now);
  const r=await o.finish('old-cookie',params(await o.start('old-cookie','selected-project')));
  assert.equal(r.projectId,'selected-project');assert.notEqual(r.cookie,'old-cookie');assert.equal(r.session.owner,'zhihu:'+hash('969570047710216201'));
  assert.equal(new URLSearchParams(calls[0].opts.body).get('code'),'test-code');assert.equal(calls[1].opts.headers.Authorization,'Bearer private-token');assert.equal(JSON.stringify(r).includes('private-token'),false);
  assert.equal((await o.session(r.cookie)).name,'测试用户');now=3600001;assert.equal(await o.session(r.cookie),null);
});
test('logout invalidates a login even while token exchange is in flight',async()=>{
  let release;const gate=new Promise(r=>release=r);let calls=0;
  const o=new OAuth(env,async()=>{calls++;if(calls===1){await gate;return response({access_token:'token',expires_in:60});}return response({hash_id:'user',fullname:'name'});});
  const running=o.finish('cookie',params(await o.start('cookie')));await o.logout('cookie');release();await assert.rejects(running,/取消/);
});
// 关键新增：start 与 callback 落在不同实例（Serverless 的常态）时登录必须成功。
// 改造前这一条一定失败，失败原因是 OAUTH_STATE。
test('login completes when start and callback land on different instances',async()=>{
  const shared=createMemoryStore();let calls=0;
  const exchange=async()=>{calls++;return calls%2?response({access_token:'tok',expires_in:3600}):response({hash_id:'shared-user',fullname:'跨实例用户'});};
  const instanceA=new OAuth(env,exchange,Date.now,shared);
  const instanceB=new OAuth(env,exchange,Date.now,shared);
  const started=params(await instanceA.start('cookie-a','proj-1'));
  const r=await instanceB.finish('cookie-a',started);
  assert.equal(r.session.owner,'zhihu:'+hash('shared-user'));
  assert.equal(r.projectId,'proj-1');
  assert.equal((await instanceA.session(r.cookie)).name,'跨实例用户');
});
// logout 的吊销也必须跨实例生效，否则 Serverless 上退出登录是假的。
test('logout revokes the session across instances',async()=>{
  const shared=createMemoryStore();let calls=0;
  const exchange=async()=>{calls++;return calls%2?response({access_token:'tok',expires_in:3600}):response({hash_id:'revoke-user',fullname:'待退出'});};
  const instanceA=new OAuth(env,exchange,Date.now,shared);
  const instanceB=new OAuth(env,exchange,Date.now,shared);
  const r=await instanceA.finish('cookie-a',params(await instanceA.start('cookie-a')));
  assert.ok(await instanceB.session(r.cookie));
  await instanceB.logout(r.cookie);
  assert.equal(await instanceA.session(r.cookie),null);
});
// 假 Upstash REST 端点：只实现适配器实际用到的命令，用来验证 REST 契约，
// 不联网、不涉及真实凭据。SCAN 分页也按真实语义返回游标。
function fakeRedis(){
  const map=new Map(),exp=new Map(),log=[];
  const store={
    alive:k=>map.has(k)&&(!exp.has(k)||exp.get(k)>Date.now()),
    value:k=>{if(!store.alive(k)){map.delete(k);exp.delete(k);return null;}return map.get(k);},
  };
  const run=a=>{
    const [cmd,...args]=a,up=String(cmd).toUpperCase();
    if(up==='GET')return store.value(args[0]);
    if(up==='SET'){map.set(args[0],args[1]);const ex=args.indexOf('EX');if(ex>-1)exp.set(args[0],Date.now()+Number(args[ex+1])*1000);else exp.delete(args[0]);return 'OK';}
    if(up==='DEL'){let n=0;for(const k of args)if(store.alive(k)){map.delete(k);exp.delete(k);n++;}return n;}
    if(up==='INCR'){const cur=Number(store.value(args[0]))||0;const next=cur+1;map.set(args[0],String(next));return next;}
    if(up==='EXPIRE'){if(!store.alive(args[0]))return 0;exp.set(args[0],Date.now()+Number(args[1])*1000);return 1;}
    if(up==='SCAN'){
      // 真实 Redis 的 SCAN 游标是不透明值；一次返回全部、游标归零即可。
      // 命令形如 SCAN <cursor> MATCH <pattern> COUNT <n>，模式在 args[2]。
      const glob=String(args[2]??'*');
      const pattern=glob.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');
      const rx=new RegExp(`^${pattern}$`);
      return ['0',[...map.keys()].filter(k=>rx.test(k))];
    }
    throw new Error('unsupported '+up);
  };
  return {log,map,run};
}
async function startFakeRedis(behavior='ok'){
  const redis=fakeRedis();
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=Buffer.concat(chunks).toString();
    redis.log.push({auth:req.headers.authorization,body});
    if(behavior==='auth-error'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'WRONGPASS'}));return;}
    if(behavior==='http-500'){res.writeHead(500);res.end('boom');return;}
    let result;try{result=redis.run(JSON.parse(body));}catch(e){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({result}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}`,redis,close:()=>new Promise(r=>server.close(r))};
}

test('redis adapter speaks the REST contract with TTL, counters and prefix delete',async()=>{
  const fake=await startFakeRedis();
  try{
    const store=createRedisStore({url:fake.url,token:'test-token',prefix:'cd:',fetcher:fetch});
    await store.set('a',JSON.stringify({v:1}),60);
    assert.equal(JSON.parse(await store.get('a')).v,1);
    assert.equal(await store.get('missing'),null);
    assert.equal(await store.incr('n',60),1);
    assert.equal(await store.incr('n',60),2);
    await store.set('p:1','x',60);await store.set('p:2','y',60);await store.set('q:1','z',60);
    assert.equal(await store.delByPrefix('p:'),2);
    assert.equal(await store.get('q:1'),'z');
    assert.equal(await store.del('q:1'),1);
    // 命名空间必须带上，避免和同一 Redis 里的其他键冲突
    assert.ok(fake.redis.map.has('cd:a'));
    // 凭据走 Authorization 头，不进 URL
    assert.ok(fake.redis.log.every(x=>x.auth==='Bearer test-token'));
    assert.ok(fake.redis.log.every(x=>!x.body.includes('test-token')));
  }finally{await fake.close();}
});
test('redis TTL expires a session instead of trusting the process clock',async()=>{
  const fake=await startFakeRedis();
  try{
    const store=createRedisStore({url:fake.url,token:'t',fetcher:fetch});
    await store.set('short','v',1);
    assert.equal(await store.get('short'),'v');
    await new Promise(r=>setTimeout(r,1100));
    assert.equal(await store.get('short'),null);
  }finally{await fake.close();}
});
test('redis storage failure surfaces as a retryable 503, not a silent logout',async()=>{
  const broken=await startFakeRedis('auth-error');
  try{
    const store=createRedisStore({url:broken.url,token:'bad',fetcher:fetch});
    await assert.rejects(store.get('a'),e=>e.code==='KV_UNAVAILABLE'&&e.status===503);
  }finally{await broken.close();}
});
// 完整链路：两个 OAuth 实例 + 真 REST 适配器 + 假 Upstash 端点。
test('full login works across instances over the redis adapter',async()=>{
  const fake=await startFakeRedis();
  try{
    const makeStore=()=>createRedisStore({url:fake.url,token:'t',prefix:'cd:',fetcher:fetch});
    let calls=0;const exchange=async()=>{calls++;return calls%2?response({access_token:'tok',expires_in:3600}):response({hash_id:'redis-user',fullname:'Redis 用户'});};
    const instanceA=new OAuth(env,exchange,Date.now,makeStore());
    const instanceB=new OAuth(env,exchange,Date.now,makeStore());
    const r=await instanceB.finish('cookie-a',params(await instanceA.start('cookie-a')));
    assert.equal((await instanceA.session(r.cookie)).name,'Redis 用户');
    assert.equal(r.session.owner,'zhihu:'+hash('redis-user'));
    await instanceA.logout(r.cookie);
    assert.equal(await instanceB.session(r.cookie),null);
  }finally{await fake.close();}
});
test('only selected project transfers, with completed operations and isolation',()=>{
  const s=new Store(':memory:');try{
    for(const id of ['a','b'])s.save({id,owner:'guest',text:'draft'});
    s.saveOp({id:'op',project:'a',owner:'guest',key:'k',status:'succeeded'});
    s.transfer('a','guest','user');assert.equal(s.get('a','user').owner,'user');assert.throws(()=>s.get('a','guest'));assert.equal(s.get('b','guest').id,'b');assert.equal(s.getOp('op','user').owner,'user');
    s.saveOp({id:'busy',project:'b',owner:'guest',key:'k2',status:'running'});assert.throws(()=>s.transfer('b','guest','user'),/运行/);assert.equal(s.get('b','guest').owner,'guest');
  }finally{s.close();}
});
test('provider uses explicit question theme and opaque next offset, stops malformed pagination',async()=>{
  const calls=[];const p=createProviders({ZHIHU_ACCESS_SECRET:'secret'},async(url)=>{calls.push(url);return response({Code:0,Data:url.pathname.includes('recommendations')?{Items:[{Title:'测试题',Url:'https://www.zhihu.com/question/123'}]}:{Items:[],Paging:{IsEnd:false,NextOffset:57}}});});
  await assert.rejects(p.questions('',new AbortController().signal));assert.equal(calls.length,0);
  const list=await p.questions('远程办公',new AbortController().signal);assert.equal(list.length,1);assert.equal(calls[0].searchParams.get('Query'),'远程办公');
  const page=await p.answers(list[0].url,0,new AbortController().signal);assert.equal(page.nextOffset,57);assert.equal(page.items.length,0);
  const bad=createProviders({ZHIHU_ACCESS_SECRET:'secret'},async()=>response({Code:0,Data:{Items:[],Paging:{IsEnd:false}}}));assert.equal((await bad.answers(list[0].url,0,new AbortController().signal)).nextOffset,null);
});
test('search separates auth failure from empty response and preserves provenance',async()=>{
  const signal=new AbortController().signal;
  const bad=createProviders({ZHIHU_ACCESS_SECRET:'secret'},async()=>response({Code:20001}));await assert.rejects(bad.search('zhihu_search','q',signal),e=>e.code==='PROVIDER_AUTH');
  const empty=createProviders({ZHIHU_ACCESS_SECRET:'secret'},async()=>response({Code:0,Data:{Items:[],EmptyReason:'没有匹配'}}));assert.equal((await empty.search('zhihu_search','q',signal)).emptyReason,'没有匹配');
});
test('HTTP question project and answer pages retain context, never replace draft',async t=>{
  const app=createApp({file:':memory:',providers:{status:{},questions:async()=>[{title:'测试问题',url:'https://www.zhihu.com/question/1'}],answers:async()=>({items:[{summary:'测试摘要',url:'https://www.zhihu.com/answer/2'}],nextOffset:17,isEnd:false,warning:''})}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const r=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'这是我对于当前讨论问题的初步草稿，需要继续补充材料。',question:{url:'https://www.zhihu.com/question/1',title:'测试问题'}})});
  const cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),p=await r.json();
  const answer=await fetch(base+`/api/projects/${p.id}/answers`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{"offset":0}'});assert.equal(answer.status,200);
  const after=await (await fetch(base+`/api/projects/${p.id}`,{headers:{cookie}})).json();assert.equal(after.text,p.text);assert.equal(after.question.url,p.question.url);assert.equal(after.answerPage.nextOffset,17);assert.equal(after.sources.length,0);
});
test('HTTP OAuth moves only chosen draft and logout restores anonymous space',async t=>{
  const oauth=new OAuth(env,async url=>response(url.endsWith('/access_token')?{access_token:'fixture-token',expires_in:60}:{hash_id:'fixture-user',fullname:'测试账号'}));
  const app=createApp({file:':memory:',providers:{status:{}},oauth});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`,jar=new Map();
  async function req(path,method='GET',body){const r=await fetch(base+path,{method,redirect:'manual',headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...(method==='POST'?{'Content-Type':'application/json'}:{})},body:method==='POST'?JSON.stringify(body):undefined});for(const c of r.headers.getSetCookie()){const [k,v]=c.split(';')[0].split('=');jar.set(k,v);}return r;}
  const a=await(await req('/api/projects','POST',{text:'这是准备关联账号的一篇测试草稿，包含必要的背景说明。'})).json();
  const b=await(await req('/api/projects','POST',{text:'这是留在匿名空间的一篇测试草稿，不能被自动迁移。'})).json();
  const link=await(await req('/api/auth/start','POST',{projectId:a.id})).json();const p=params(link.url);
  const callback=await req('/auth/zhihu/callback?'+p.toString());assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/?login=success');
  assert.equal((await(await req('/api/auth')).json()).user.name,'测试账号');assert.equal((await req('/api/projects/'+a.id)).status,200);assert.equal((await req('/api/projects/'+b.id)).status,404);
  await req('/api/auth/logout','POST',{});assert.equal((await req('/api/projects/'+a.id)).status,404);assert.equal((await req('/api/projects/'+b.id)).status,200);
});
