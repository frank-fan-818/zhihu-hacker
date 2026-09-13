import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestHandler } from '../src/server.mjs';
import { OAuth } from '../src/oauth.mjs';
import { createMemoryStore } from '../src/kv.mjs';

// 模拟 Vercel 的调用方式：函数直接收到 (req,res)，不走监听端口。
// 同时设定 VERCEL / APP_ORIGIN，进入部署时的代码路径。
const handlers=[];const cleanups=[];
function vercelHandler(options={}){
  const previous={VERCEL:process.env.VERCEL,APP_ORIGIN:process.env.APP_ORIGIN};
  process.env.VERCEL='1';
  process.env.APP_ORIGIN='https://demo.vercel.app';
  try{
    const handler=createRequestHandler(options);
    handlers.push(()=>{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
    return handler;
  }catch(e){for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}throw e;}
}
function reqRes({method='GET',url='/',host='demo.vercel.app',headers={},body,cookie}={}){
  const req=new EventEmitter();
  req.method=method;req.url=url;
  req.headers={host,...(cookie?{cookie}:{}),...(method==='POST'?{'content-type':'application/json',origin:'https://demo.vercel.app'}:{}),...headers};
  // 真实运行时（Vercel 的 createServer + undiciRequest）交来的是 IncomingMessage；
  // 这里补出 server.mjs 用到的部分：异步迭代请求体 + socket 字段。
  req.socket={remoteAddress:'127.0.0.1'};
  req[Symbol.asyncIterator]=async function*(){
    const chunks=[];
    const finished=new Promise(resolve=>{
      req.on('data',chunk=>chunks.push(Buffer.from(chunk)));
      req.on('end',()=>resolve());
    });
    setImmediate(()=>{
      if(body!==undefined)req.emit('data',Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
    await finished;
    yield* chunks;
  };
  const res={statusCode:0,headers:{},setHeader(k,v){this.headers[String(k).toLowerCase()]=v;},getHeader(k){return this.headers[String(k).toLowerCase()];},writeHead(status,extra){this.statusCode=status;if(extra)for(const [k,v] of Object.entries(extra))this.headers[String(k).toLowerCase()]=v;return this;},end(payload){this.payload=payload;this.finished=true;this.resolveFinished();}};
  let resolveFinished=()=>{};
  res.finishedPromise=new Promise(resolve=>{resolveFinished=resolve;});
  res.resolveFinished=resolveFinished;
  return {req,res};
}
// 数据库落在临时目录：这里验证的是部署形态下的路径选择，不是持久性。
// 不主动删目录——Windows 上仍被 SQLite 句柄占用的文件会导致 rmSync EPERM，
// 临时目录由系统回收即可。
function tmpFile(){const dir=mkdtempSync(join(tmpdir(),'cd-vercel-'));return join(dir,'app.sqlite');}
const fixtureProviders={status:{model:false,zhihu:false},answers:async()=>({items:[],nextOffset:null,isEnd:true,warning:''}),questions:async()=>[]};

test.beforeEach(()=>{handlers.length=0;});
test.afterEach(()=>{while(handlers.length)handlers.pop()();});

test('vercel handler serves the page, static assets and the API from one entrypoint',async t=>{
  const handler=vercelHandler({file:tmpFile(t),providers:fixtureProviders});
  const page=await run(handler,{url:'/'});
  assert.equal(page.statusCode,200);
  assert.match(String(page.headers['content-type']),/text\/html/);
  assert.ok(String(page.payload).length>0);

  const asset=await run(handler,{url:'/style.css'});
  assert.equal(asset.statusCode,200);

  const created=await run(handler,{method:'POST',url:'/api/projects',body:{text:'这是一段用于验证部署形态的测试草稿，包含足够长度的说明文字。'}});
  assert.equal(created.statusCode,201,`POST /api/projects 返回 ${created.statusCode}：${String(created.payload)}`);
});
test('vercel handler rejects an unrelated host',async t=>{
  const handler=vercelHandler({file:tmpFile(t),providers:fixtureProviders});
  const blocked=await run(handler,{url:'/',host:'evil.example.com'});
  assert.equal(blocked.statusCode,403);
});
test('vercel handler accepts the www form of the registered origin',async t=>{
  const handler=vercelHandler({file:tmpFile(t),providers:fixtureProviders});
  const ok=await run(handler,{url:'/',host:'www.demo.vercel.app'});
  assert.equal(ok.statusCode,200);
});
// 部署形态下的登录：start 与 callback 由不同函数实例处理，共享同一份键值存储。
test('login survives across two separate vercel handler instances',async t=>{
  const shared=createMemoryStore();
  const env={ZHIHU_OAUTH_APP_ID:'id',ZHIHU_OAUTH_APP_KEY:'key',ZHIHU_OAUTH_REDIRECT_URI:'https://demo.vercel.app/auth/zhihu/callback',APP_ORIGIN:'https://demo.vercel.app'};
  let calls=0;
  const exchange=async()=>{calls++;return calls%2?new Response(JSON.stringify({access_token:'tok',expires_in:3600})):new Response(JSON.stringify({hash_id:'vercel-user',fullname:'部署用户'}));};
  const file=tmpFile(t);
  const handlerA=vercelHandler({file,providers:fixtureProviders,oauth:new OAuth(env,exchange,Date.now,shared)});
  const handlerB=vercelHandler({file,providers:fixtureProviders,oauth:new OAuth(env,exchange,Date.now,shared)});

  const jar=new Map();
  const cookieHeader=()=>[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
  const collect=res=>{const raw=res.headers['set-cookie'];if(!raw)return;for(const one of Array.isArray(raw)?raw:[raw]){const [pair]=String(one).split(';');const [k,v]=pair.split('=');jar.set(k,v);}};

  const project=await run(handlerA,{method:'POST',url:'/api/projects',body:{text:'登录后应当归入账号的一篇部署测试草稿，长度足够。'}});
  collect(project);
  const created=JSON.parse(String(project.payload));

  const started=await run(handlerA,{method:'POST',url:'/api/auth/start',body:{projectId:created.id},cookie:cookieHeader()});
  collect(started);
  const authorize=new URL(JSON.parse(String(started.payload)).url);
  assert.equal(authorize.origin,'https://openapi.zhihu.com');
  assert.equal(authorize.searchParams.get('redirect_uri'),env.ZHIHU_OAUTH_REDIRECT_URI);

  // 回调落到另一个实例：改造前这里必定 OAUTH_STATE 失败。
  const callback=await run(handlerB,{url:`/auth/zhihu/callback?state=${encodeURIComponent(authorize.searchParams.get('state'))}&authorization_code=code-1`,cookie:cookieHeader()});
  assert.equal(callback.statusCode,303);
  assert.equal(callback.headers.location,'/?login=success');
  collect(callback);

  const auth=await run(handlerB,{url:'/api/auth',cookie:cookieHeader()});
  assert.equal(JSON.parse(String(auth.payload)).user.name,'部署用户');
  const moved=await run(handlerB,{url:`/api/projects/${created.id}`,cookie:cookieHeader()});
  assert.equal(moved.statusCode,200);
});
async function run(handler,options){
  const {req,res}=reqRes(options);
  handler(req,res);
  await res.finishedPromise;
  return {statusCode:res.statusCode,headers:res.headers,payload:res.payload};
}
