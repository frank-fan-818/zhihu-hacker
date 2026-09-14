import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Service } from '../src/service.mjs';
import { AppError } from '../src/domain.mjs';
import { createProviders } from '../src/providers.mjs';
import { createApp } from '../src/server.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const text='我正在考虑如何调整团队安排。远程办公一定能提高所有人的工作效率。但具体任务类型仍值得仔细讨论。';
const fixtureSource=kind=>({id:kind,provider:kind,title:'测试来源（仅测试夹具）',url:`https://example.org/${kind}`,text:'测试摘要',relation:'unreviewed'});
async function fixture(t,options={}){
  const store=new Store(':memory:');const calls=[];
  const providers={status:{model:false,zhihu:true},search:async kind=>{calls.push(kind);return [fixtureSource(kind)];},...options};
  const service=new Service(store,providers);t.after(()=>store.close());
  return {store,service,calls,p:await service.create('owner',text)};
}
async function done(store,op){
  op=await op;
  for(let i=0;i<200;i++){const current=store.getOp(op.id,op.owner);if(!['queued','running'].includes(current.status))return current;await new Promise(r=>setTimeout(r,3));}
  throw new Error('operation timeout');
}
async function check(f){await done(f.store,await f.service.start('owner',f.p.id,{type:'quick_check',key:'check-key-01',revision:1}));return f.store.get(f.p.id,'owner').findings[0];}
test('initial check makes zero search calls, returns a real anchor',async t=>{
  const f=await fixture(t);await check(f);assert.equal(f.calls.length,0);assert.equal(f.store.get(f.p.id,'owner').findings.length,1);
});
test('verification makes at most one call per source and reopening uses cache',async t=>{
  const f=await fixture(t);const item=await check(f);
  const a={type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id};
  const op=await f.service.start('owner',f.p.id,a);assert.equal((await f.service.start('owner',f.p.id,a)).id,op.id);
  assert.equal((await done(f.store,op)).status,'succeeded');assert.equal(f.calls.length,2);
  await done(f.store,await f.service.start('owner',f.p.id,{...a,key:'verify-key-02'}));assert.equal(f.calls.length,2);
});
test('idempotency key cannot be reused for a different payload',async t=>{
  const f=await fixture(t);await check(f);
  await assert.rejects(async()=>await f.service.start('owner',f.p.id,{type:'review_remaining',key:'check-key-01',revision:1}),/标识/);
});
test('partial search failure preserves real successful results',async t=>{
  const f=await fixture(t,{search:async kind=>{if(kind==='global_search')throw new AppError('LIMIT','限额');return [fixtureSource(kind)];}});const item=await check(f);
  const op=await done(f.store,await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id}));
  assert.equal(op.status,'partial');const p=f.store.get(f.p.id,'owner');assert.equal(p.sources.length,1);assert.equal(p.verification[item.id].errors.length,1);
});
// 线上真实故障：模型密钥失效时，每次“查依据”都只拿到摘要，而错误提示若只写“未完成”，
// 用户与开发者都看不出根因。这里固定“必须带上模型返回的原因”。
test('model failure during verification names the real reason',async t=>{
  const f=await fixture(t,{status:{model:true,zhihu:true},model:async()=>{throw new AppError('MODEL_UNAVAILABLE','模型服务请求失败（HTTP 401）。',502);}});
  const item=await check(f);
  const op=await done(f.store,await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id}));
  assert.equal(op.status,'partial');
  const p=f.store.get(f.p.id,'owner');
  const message=p.verification[item.id].errors.join(' ');
  assert.match(message,/HTTP 401/);
  assert.equal(p.sources.every(s=>s.relation==='unreviewed'),true);
});
// 只做检索、没配模型不是失败：否则同一句重复点会重新消耗检索额度，也不写缓存。
test('retrieval without a model is not treated as a failure',async t=>{
  const f=await fixture(t);
  const item=await check(f);
  const op=await done(f.store,await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id}));
  assert.equal(op.status,'succeeded');
  const first=f.store.get(f.p.id,'owner');
  assert.deepEqual(first.verification[item.id].errors,[]);
  assert.match(first.verification[item.id].summary,/未配置模型/);
  const again=await done(f.store,await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-02',revision:1,findingId:item.id}));
  assert.equal(again.cached,true);
  assert.equal(f.calls.length,2);
});
// 反过来：以失败结束的结果不写缓存，否则一次瞬时故障会锁住 30 分钟。
// 代价是重复点击会重新检索——这是明确的取舍，不能让测试以为“失败也该缓存”。
test('partial results are never served from a 30-minute cache',async t=>{
  const f=await fixture(t,{status:{model:true,zhihu:true},model:async()=>{throw new AppError('MODEL_UNAVAILABLE','模型服务请求失败（HTTP 401）。',502);}});
  const item=await check(f);
  const first=await done(f.store,await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id}));
  assert.equal(first.status,'partial');
  const second=await done(f.store,await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-02',revision:1,findingId:item.id}));
  assert.equal(second.cached,undefined);
  assert.equal(second.status,'partial');
  assert.equal(f.calls.length,4);
});
test('missing credentials produces no invented evidence',async t=>{
  const f=await fixture(t,{status:{model:false,zhihu:false}});const item=await check(f);
  const op=await done(f.store,await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id}));
  assert.equal(op.error.code,'ZHIHU_NOT_CONFIGURED');assert.equal(f.calls.length,0);assert.equal(f.store.get(f.p.id,'owner').sources.length,0);
});
test('cancelled search cannot write late results',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const f=await fixture(t,{search:async kind=>{await wait;return [fixtureSource(kind)];}});const item=await check(f);
  const op=await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id});
  await new Promise(r=>setTimeout(r,5));await f.service.cancel('owner',op.id);release();await new Promise(r=>setTimeout(r,15));
  assert.equal(f.store.getOp(op.id,'owner').status,'cancelled');assert.equal(f.store.get(f.p.id,'owner').sources.length,0);
});
test('draft edit during search makes results stale',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const f=await fixture(t,{search:async kind=>{await wait;return [fixtureSource(kind)];}});const item=await check(f);
  const op=await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id});
  await new Promise(r=>setTimeout(r,5));await f.service.edit('owner',f.p.id,text+'我补充了新的背景。',1);release();
  assert.equal((await done(f.store,op)).error.code,'STALE_RESULT');assert.equal(f.store.get(f.p.id,'owner').sources.length,0);
});
test('deleting active project cannot resurrect data',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const f=await fixture(t,{search:async kind=>{await wait;return [fixtureSource(kind)];}});const item=await check(f);
  await f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id});
  await new Promise(r=>setTimeout(r,5));await f.service.remove('owner',f.p.id);release();await new Promise(r=>setTimeout(r,15));
  assert.throws(()=>f.store.get(f.p.id,'owner'));assert.equal(f.store.list('owner').length,0);
});
// 模型配了却跑不成（密钥失效、网关故障）时，检查不能整体失败，也不能假装“没有问题”：
// 退回本地规则，并把这次是谁看的稿、为什么没看成，写进 lastCheck 让面板如实显示。
test('model failure falls back to local rules and records why',async t=>{
  const f=await fixture(t,{status:{model:true,zhihu:false},model:async()=>{throw new AppError('MODEL_UNAVAILABLE','模型服务请求失败（HTTP 401）。',502);}});
  const op=await done(f.store,await f.service.start('owner',f.p.id,{type:'quick_check',key:'degraded-key-1',revision:1}));
  assert.equal(op.status,'succeeded');
  const after=f.store.get(f.p.id,'owner');
  assert.equal(after.lastCheck.engine,'local_rules');
  assert.match(after.lastCheck.note,/HTTP 401/);
  assert.equal(after.findings.length,1);
  assert.equal(after.findings[0].engine,'local_rules');
});
// 模型成功时（这里用夹具模拟）应保留 model 引擎，且不留下任何降级说明。
test('model success keeps the model engine and writes no note',async t=>{
  const f=await fixture(t,{status:{model:true,zhihu:false},model:async()=>({items:[{quote:'远程办公一定能提高所有人的工作效率。',start:text.indexOf('远程办公一定'),kind:'以偏概全',reason:'结论写成“所有人”，但文中依据只到个人半年的体验，读者会追问样本覆盖了哪些任务类型。',severity:'中等',impact:'影响可信度',direction:'补充条件'}]})});
  await done(f.store,await f.service.start('owner',f.p.id,{type:'quick_check',key:'model-key-1',revision:1}));
  const after=f.store.get(f.p.id,'owner');
  assert.equal(after.lastCheck.engine,'model');
  assert.equal(after.lastCheck.note,undefined);
  assert.equal(after.findings[0].engine,'model');
  assert.equal(after.findings[0].severity,'中等');
  assert.equal(after.findings[0].direction,'补充条件');
});
test('wording-only suggestion applies and safely undoes without search',async t=>{
  const f=await fixture(t);const item=await check(f);
  await assert.rejects(async()=>await f.service.start('owner',f.p.id,{type:'suggest_revision',key:'suggest-key-0',revision:1,findingId:item.id}),/先查看依据/);
  await done(f.store,await f.service.start('owner',f.p.id,{type:'suggest_revision',key:'suggest-key-1',revision:1,findingId:item.id,wordingOnly:true}));
  const s=f.store.get(f.p.id,'owner').suggestions[0];const applied=await f.service.apply('owner',f.p.id,s.id,1);
  assert.ok(applied.text.includes('是否'));assert.equal(applied.revision,2);assert.equal(f.calls.length,0);
  assert.equal((await f.service.undo('owner',f.p.id,2)).text,text);
});
test('manual edit after apply prevents destructive undo',async t=>{
  const f=await fixture(t);const item=await check(f);
  await done(f.store,await f.service.start('owner',f.p.id,{type:'suggest_revision',key:'suggest-key-1',revision:1,findingId:item.id,wordingOnly:true}));
  const p=await f.service.apply('owner',f.p.id,f.store.get(f.p.id,'owner').suggestions[0].id,1);
  await f.service.edit('owner',p.id,p.text+'新的编辑。',2);await assert.rejects(async()=>await f.service.undo('owner',p.id,3),/后续编辑/);
});
// 乐观并发控制必须在数据库层生效：两个写者各自读到同一 revision 后并发提交，
// 只能有一个成功。仅靠应用层先读后写的比较，两次都会通过检查而丢失一次更新。
test('concurrent writers on the same revision cannot both win',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const service=new Service(store,{status:{model:false,zhihu:false}});
  const p=await service.create('owner',text);
  const a=store.get(p.id,'owner'), b=store.get(p.id,'owner');   // 两个写者读到相同 revision
  assert.equal(a.revision,b.revision);
  const first=await service.saveGuarded({...a,text:'甲写者的修改内容，长度足够通过校验。'},1,'冲突');
  assert.equal(first.revision,2);
  await assert.rejects(async()=>await service.saveGuarded({...b,text:'乙写者的修改内容，长度足够通过校验。'},1,'冲突'),
    e=>e.code==='REVISION_CONFLICT');
  // 最终内容必须是先提交那次，且 revision 只前进一格
  const after=store.get(p.id,'owner');
  assert.equal(after.text,'甲写者的修改内容，长度足够通过校验。');
  assert.equal(after.revision,2);
});
// 生成列必须与 JSON 里的 revision 保持一致，否则条件更新会失效
test('revision generated column tracks the document',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const p=store.save({id:'pg',owner:'o',text:'一段用于校验生成列的草稿内容，长度足够。',revision:7});
  assert.equal(store.db.prepare('SELECT revision FROM projects WHERE id=?').get('pg').revision,7);
  store.save({...p,revision:8});
  assert.equal(store.db.prepare('SELECT revision FROM projects WHERE id=?').get('pg').revision,8);
});
test('sqlite persists content and interrupts unfinished operation after restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cognitive-test-'));const file=join(dir,'test.sqlite');
  try{let store=new Store(file);store.save({id:'p',owner:'a',text:'保留的内容'});store.saveOp({id:'op',project:'p',owner:'a',key:'key',status:'running'});store.close();
    store=new Store(file);store.recoverInterruptedOperations({exclusive:true});assert.equal(store.get('p','a').text,'保留的内容');assert.equal(store.getOp('op','a').error.code,'INTERRUPTED');store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('HTTP sessions isolate projects and reject cross-origin mutation',async t=>{
  const app=createApp({file:':memory:',providers:{status:{model:false,zhihu:false}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const created=await fetch(`${base}/api/projects`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
  const cookie=created.headers.get('set-cookie').split(';')[0];const p=await created.json();assert.equal(created.status,201);assert.equal(p.owner,undefined);
  assert.equal((await fetch(`${base}/api/projects/${p.id}`)).status,404);
  assert.equal((await fetch(`${base}/api/projects/${p.id}`,{headers:{cookie}})).status,200);
  assert.equal((await fetch(`${base}/api/projects/${p.id}`,{method:'PATCH',headers:{cookie,Origin:'https://malicious.example','Content-Type':'application/json'},body:JSON.stringify({text,revision:1})})).status,403);
});
test('provider keeps secret on server and normalizes snippets using fixture transport',async()=>{
  let seen;
  const p=createProviders({ZHIHU_ACCESS_SECRET:'test-only'},async(url,opts)=>{seen={url,opts};return new Response(JSON.stringify({Code:0,Data:{Items:[{Title:'测试',ContentText:'<em>摘要</em>',Url:'https://example.org/a'},{ContentText:'坏链接',Url:'javascript:alert(1)'}]}}));});
  const result=await p.search('zhihu_search','测试查询',new AbortController().signal);
  assert.equal(seen.url.hostname,'developer.zhihu.com');assert.equal(seen.url.searchParams.get('Count'),'5');assert.equal(seen.opts.headers.Authorization,'Bearer test-only');assert.equal(result.length,1);assert.equal(result[0].text,'摘要');assert.equal(JSON.stringify(result).includes('test-only'),false);
});
