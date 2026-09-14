import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OAuth } from '../src/oauth.mjs';
import { createMemoryStore, createRedisStore, storeStatus } from '../src/kv.mjs';
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
  const running=o.finish('cookie',params(await o.start('cookie')));await o.logout('cookie');release();
  // logout 会先作废待处理 state，因此失败可能报"失效"或"已取消"，两者都表示登录未成立。
  await assert.rejects(running,/失效|取消/);
  assert.equal(await o.session('cookie'),null);
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
    if(up==='EVAL'){
      const [script,n,...values]=args,keys=values.slice(0,Number(n)),argv=values.slice(Number(n));
      if(script.startsWith('-- oauth-consume')){const value=store.value(keys[0]);run(['DEL',keys[0]]);return value;}
      if(script.startsWith('-- oauth-commit')){
        if(Number(store.value(keys[0]))>0)return 0;
        run(['SET',keys[1],argv[0],'EX',argv[1]]);run(['DEL',keys[2]]);return 1;
      }
      if(script.startsWith('-- oauth-revoke')){
        const epoch=run(['INCR',keys[0]]);run(['EXPIRE',keys[0],argv[0]]);run(['DEL',keys[1]]);return epoch;
      }
      throw new Error('unsupported Lua fixture');
    }
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

test('Redis atomic state consumption and rotated-session revocation work across clients',async()=>{
  const fake=await startFakeRedis();
  try{
    const first=createRedisStore({url:fake.url,token:'t',prefix:'audit:'});
    const second=createRedisStore({url:fake.url,token:'t',prefix:'audit:'});
    await first.set('state','pending',60);
    const claims=await Promise.all([first.consume('state'),second.consume('state')]);
    assert.deepEqual(claims.sort(),['pending',null].sort());
    await first.revokeSession('epoch','old-session',3600);
    assert.equal(await second.commitSession('epoch','new-session','old-session','value',60),false);
    assert.equal(await first.get('new-session'),null);
    const a=new OAuth(env,async url=>response(url.endsWith('/access_token')?{access_token:'t',expires_in:60}:{hash_id:'u'}),Date.now,first);
    const b=new OAuth(env,a.fetcher,Date.now,second);
    const result=await a.finish('late-cookie',params(await b.start('late-cookie')));
    await b.logout('late-cookie');
    assert.equal(await a.session(result.cookie),null);
    const commands=fake.redis.log.map(x=>JSON.parse(x.body)).filter(x=>x[0]==='EVAL');
    assert.ok(commands.length>0);
    assert.ok(commands.every(c=>c.slice(3,3+Number(c[2])).every(k=>k.startsWith('audit:'))));
  }finally{await fake.close();}
});
// Vercel 的 Upstash 集成注入的是 KV_REST_API_URL / KV_REST_API_TOKEN，
// 名字不由本项目决定，必须能识别，否则线上仍会退回内存实现、登录失效。
test('shared store accepts the variable names Vercel injects',async()=>{
  assert.equal(storeStatus({}).kind,'memory');
  assert.equal(storeStatus({KV_REST_API_URL:'https://x.upstash.io'}).durable,false);
  const viaKv=storeStatus({KV_REST_API_URL:'https://x.upstash.io',KV_REST_API_TOKEN:'t'});
  assert.equal(viaKv.kind,'redis');assert.equal(viaKv.durable,true);assert.equal(viaKv.credentials,'KV_REST_API_TOKEN');
  const viaOwn=storeStatus({SESSION_STORE_URL:'https://y.upstash.io',SESSION_STORE_TOKEN:'t2'});
  assert.equal(viaOwn.kind,'redis');assert.equal(viaOwn.credentials,'SESSION_STORE_TOKEN');
  // 自定义名字优先，便于本地覆盖平台注入的值
  const both=storeStatus({SESSION_STORE_URL:'https://y.upstash.io',SESSION_STORE_TOKEN:'t2',KV_REST_API_URL:'https://x.upstash.io',KV_REST_API_TOKEN:'t'});
  assert.equal(both.kind,'redis');assert.equal(both.credentials,'SESSION_STORE_TOKEN');
  assert.equal(storeStatus({KV_REST_API_URL:'https://x.upstash.io'}).issue.includes('KV_REST_API_TOKEN'),true);
});
// 线上真实失败场景：用户重复点「知乎登录」（或第一下没反应又点一次）。
// 两次签发的 state 都必须有效，否则用户完成的那次回调一定报 OAUTH_STATE。
test('starting login again does not invalidate the earlier authorization',async()=>{
  const shared=createMemoryStore();let calls=0;
  const exchange=async()=>{calls++;return calls%2?response({access_token:'tok',expires_in:3600}):response({hash_id:'twice-user',fullname:'重复点击'});};
  const o=new OAuth(env,exchange,Date.now,shared);
  const first=params(await o.start('cookie-a'));
  const second=params(await o.start('cookie-a'));
  assert.notEqual(first.get('state'),second.get('state'));
  // 用户完成的是「第一次」那次授权——必须成功
  const r=await o.finish('cookie-a',first);
  assert.equal(r.session.owner,'zhihu:'+hash('twice-user'));
  // 已被消费的 state 不能重放
  await assert.rejects(o.finish('cookie-a',first),/失效/);
});
// 取消的语义必须保留：logout 让在途交换失败，且同会话的待处理登录一并作废。
test('logout still invalidates pending authorizations of the same session',async()=>{
  const shared=createMemoryStore();
  const o=new OAuth(env,async()=>response({}),Date.now,shared);
  const p=params(await o.start('cookie-a'));
  await o.logout('cookie-a');
  await assert.rejects(o.finish('cookie-a',p),/失效/);
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
  const calls=[];const p=createProviders({ZHIHU_ACCESS_SECRET:'secret'},async(url)=>{calls.push(url);return response({Code:0,Data:url.pathname.includes('recommendations')?{Items:[{Title:'测试题',Url:'https://www.zhihu.com/question/1230000000000000000'}]}:{Items:[],Paging:{IsEnd:false,NextOffset:57}}});});
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
  const app=createApp({file:':memory:',providers:{status:{},questions:async()=>[{title:'测试问题',url:'https://www.zhihu.com/question/1000000000000000000'}],answers:async()=>({items:[{summary:'测试摘要',url:'https://www.zhihu.com/answer/2'}],nextOffset:17,isEnd:false,warning:''})}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const r=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'这是我对于当前讨论问题的初步草稿，需要继续补充材料。',question:{url:'https://www.zhihu.com/question/1000000000000000000',title:'测试问题'}})});
  const cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),p=await r.json();
  const answer=await fetch(base+`/api/projects/${p.id}/answers`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{"offset":0}'});assert.equal(answer.status,200);
  const after=await (await fetch(base+`/api/projects/${p.id}`,{headers:{cookie}})).json();assert.equal(after.text,p.text);assert.equal(after.question.url,p.question.url);assert.equal(after.answerPage.nextOffset,17);assert.equal(after.sources.length,0);
});

test('operation events stream emits a terminal state and request id',async t=>{
  const app=createApp({file:':memory:',providers:{status:{model:false,zhihu:false}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const created=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'这是一段足够长的草稿，用于测试操作事件流是否能完整返回终态。'})});
  const cookie=created.headers.get('set-cookie').split(';')[0],p=await created.json();
  const started=await fetch(base+`/api/projects/${p.id}/operations`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'quick_check',key:'sse-test-1',revision:1})});
  const op=await started.json();assert.equal(started.status,202);assert.ok(started.headers.get('x-request-id'));
  const events=await fetch(base+`/api/operations/${op.id}/events`,{headers:{cookie}});assert.equal(events.status,200);assert.match(events.headers.get('content-type'),/text\/event-stream/);
  const body=await events.text();assert.match(body,/event: operation/);assert.match(body,/"status":"succeeded"/);
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

// 实测到的真实行为：平台对某些主题返回 Code=0 但 Items 为空（「远程办公」反复查都是空，换个说法才有结果）。
// 这种情况必须把平台给的原因带上去，否则界面只能编一句「换个更具体的主题」，把平台侧的空召回说成用户的问题。
test('empty question recall keeps the platform reason instead of inventing one',async()=>{
  const signal=new AbortController().signal;
  const empty=createProviders({ZHIHU_ACCESS_SECRET:'secret'},async()=>response({Code:0,Data:{Items:[],EmptyReason:'没有与该主题匹配的问题'}}));
  const list=await empty.questions('远程办公',signal);
  assert.equal(list.length,0);assert.equal(list.emptyReason,'没有与该主题匹配的问题');
  // 不可枚举：它只是给调用方的附注，不能混进数组元素、也不该被当成一条问题渲染出去
  assert.equal(Object.keys(list).length,0);assert.equal([...list].length,0);
  const bare=createProviders({ZHIHU_ACCESS_SECRET:'secret'},async()=>response({Code:0,Data:{Items:[]}}));
  assert.equal((await bare.questions('远程办公',signal)).emptyReason,null);
  // 空召回和调用失败必须分开：失败仍然抛错，不能伪装成「没查到」
  const failed=createProviders({ZHIHU_ACCESS_SECRET:'secret'},async()=>response({Code:30001}));
  await assert.rejects(failed.questions('远程办公',signal),e=>e.code==='PROVIDER_LIMIT');
});
// 空召回和「没查成」必须是两种答复：前者 HTTP 200 带 emptyReason，后者是非 2xx 的错误码。
test('HTTP topic search separates empty recall from a failed call',async t=>{
  const providers={status:{},questions:async q=>{if(q==='查不到的主题'){const list=[];Object.defineProperty(list,'emptyReason',{value:'没有匹配',enumerable:false});return list;}return [{title:'测试问题',url:'https://www.zhihu.com/question/1234567890'}];}};
  const app=createApp({file:':memory:',providers});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const post=async body=>{const r=await fetch(base+'/api/questions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const found=await post({query:'远程办公'});
  assert.equal(found.status,200);assert.equal(found.body.items.length,1);assert.equal(found.body.emptyReason,null);
  const none=await post({query:'查不到的主题'});
  assert.equal(none.status,200);assert.deepEqual(none.body.items,[]);assert.equal(none.body.emptyReason,'没有匹配');assert.equal(none.body.query,'查不到的主题');
});
// 粘贴链接入口的契约：/api/question-url 收下任意写法，交给 provider 的一定是规范地址。
// 归一化放在 server 而不是只放在真实 provider 里，注入假 provider 时这条契约同样成立。
test('a pasted question link normalizes every way people actually copy it',async t=>{
  const seen=[];
  const providers={status:{},questionInfo:async url=>{seen.push(url);return {url,title:'测试问题',detail:''};}};
  const app=createApp({file:':memory:',providers});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const canonical='https://www.zhihu.com/question/368830073';
  const post=async url=>{const r=await fetch(base+'/api/question-url',{method:'POST',headers:{'Content-Type':'application/json',cookie:'cognitive_session='+'f'.repeat(64)},body:JSON.stringify({url})});return {status:r.status,body:await r.json()};};
  for(const input of [canonical,'https://www.zhihu.com/question/368830073/answer/2319726894',
    'https://www.zhihu.com/question/368830073?utm_source=wechat_session&s_r=0','https://m.zhihu.com/question/368830073','368830073']){
    const r=await post(input);
    assert.equal(r.status,200,input);
    assert.equal(r.body.url,canonical,input);
    assert.equal(seen.at(-1),canonical,`落到 provider 的必须是规范地址：${input}`);
  }
  for(const bad of ['https://www.zhihu.com/people/someone','https://example.com/question/123456','远程办公','https://www.zhihu.com/question/']){
    const r=await post(bad);
    assert.equal(r.status,400,bad);
    assert.equal(r.body.error.code,'INVALID_INPUT',bad);
  }
  assert.equal(seen.length,5,'被拒的输入不该到达 provider');
});
// 回归：只贴一个链接、还没动笔时，界面会按题目起一段草稿再建项目。
// 服务端对草稿有 20—10000 字符的下限，所以空文本建项目必然 400——这条路径要在接口层固定住。
test('paste-link first draft reaches the workbench and can start a check',async t=>{
  const app=createApp({file:':memory:',providers:{status:{model:false,zhihu:false},questionInfo:async url=>({url,title:'测试问题',detail:''}),answers:async()=>({items:[],nextOffset:null,isEnd:true,warning:''})}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`,jar=new Map();
  async function req(path,method='GET',body){const r=await fetch(base+path,{method,headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...(method==='POST'?{'Content-Type':'application/json'}:{})},body:method==='POST'?JSON.stringify(body):undefined});for(const c of r.headers.getSetCookie()){const [k,v]=c.split(';')[0].split('=');jar.set(k,v);}return r;}
  const info=await (await req('/api/question-url','POST',{url:'https://www.zhihu.com/question/368830073'})).json();
  assert.equal(info.url,'https://www.zhihu.com/question/368830073');
  const empty=await req('/api/projects','POST',{text:'',question:{url:info.url,title:info.title}});
  assert.equal(empty.status,400,'服务端拒绝空草稿，所以界面必须先起一段');
  const scaffold=`关于"${info.title}"，我的初步看法是：\n\n我希望先弄清楚相关事实与适用条件，再形成自己的观点。`;
  assert.ok([...scaffold].length>=20,'起稿文字要过服务端下限');
  const created=await req('/api/projects','POST',{text:scaffold,question:{url:info.url,title:info.title}});
  assert.equal(created.status,201);
  const p=await created.json();
  assert.equal((await req(`/api/projects/${p.id}/answers`,'POST',{offset:0})).status,200);
  const op=await req(`/api/projects/${p.id}/operations`,'POST',{type:'quick_check',key:'paste-link-first-draft',revision:p.revision});
  assert.equal(op.status,202);
  const result=await (await req(`/api/operations/${(await op.json()).id}`)).json();
  assert.ok(['running','queued','succeeded','partial'].includes(result.status),result.status);
});
// 粘贴链接和按主题搜索共用同一个额度：否则「换个入口」就变成了绕过限额。
test('question-url shares the same per-identity budget as topic search',async t=>{
  const before=process.env.QUESTION_HOURLY_LIMIT,ipLimit=process.env.IP_HOURLY_LIMIT;
  process.env.IP_HOURLY_LIMIT='60';process.env.QUESTION_HOURLY_LIMIT='2';
  const seen=[];
  const providers={status:{},questionInfo:async url=>{seen.push(url);return {url,title:'测试问题',detail:''};},
    questions:async()=>{const e=new Error('本小时的问题查询已达上限。');e.code='QUESTION_LIMIT';e.status=429;throw e;}};
  const app=createApp({file:':memory:',providers});
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();
    if(ipLimit===undefined)delete process.env.IP_HOURLY_LIMIT;else process.env.IP_HOURLY_LIMIT=ipLimit;
    if(before===undefined)delete process.env.QUESTION_HOURLY_LIMIT;else process.env.QUESTION_HOURLY_LIMIT=before;});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`,cookie='cognitive_session='+'d'.repeat(64);
  const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  assert.equal((await post('/api/question-url',{url:'https://www.zhihu.com/question/368830073'})).status,200);
  assert.equal((await post('/api/question-url',{url:'https://m.zhihu.com/question/368830073'})).status,200);
  const linkDenied=await post('/api/question-url',{url:'https://www.zhihu.com/question/368830073'});
  assert.equal(linkDenied.status,429);assert.equal(linkDenied.body.error.code,'QUESTION_LIMIT');
  const topicDenied=await post('/api/questions',{query:'远程办公'});
  assert.equal(topicDenied.status,429);assert.equal(topicDenied.body.error.code,'QUESTION_LIMIT');
  assert.equal(seen.length,2,'被限额拦住的请求不该打到 provider');
});
