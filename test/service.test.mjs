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
function fixture(t,options={}){
  const store=new Store(':memory:');const calls=[];
  const providers={status:{model:false,zhihu:true},search:async kind=>{calls.push(kind);return [fixtureSource(kind)];},...options};
  const service=new Service(store,providers);t.after(()=>store.close());
  return {store,service,calls,p:service.create('owner',text)};
}
async function done(store,op){
  for(let i=0;i<200;i++){const current=store.getOp(op.id,op.owner);if(!['queued','running'].includes(current.status))return current;await new Promise(r=>setTimeout(r,3));}
  throw new Error('operation timeout');
}
async function check(f){await done(f.store,f.service.start('owner',f.p.id,{type:'quick_check',key:'check-key-01',revision:1}));return f.store.get(f.p.id,'owner').findings[0];}
test('initial check makes zero search calls, returns a real anchor',async t=>{
  const f=fixture(t);await check(f);assert.equal(f.calls.length,0);assert.equal(f.store.get(f.p.id,'owner').findings.length,1);
});
test('verification makes at most one call per source and reopening uses cache',async t=>{
  const f=fixture(t);const item=await check(f);
  const a={type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id};
  const op=f.service.start('owner',f.p.id,a);assert.equal(f.service.start('owner',f.p.id,a).id,op.id);
  assert.equal((await done(f.store,op)).status,'succeeded');assert.equal(f.calls.length,2);
  await done(f.store,f.service.start('owner',f.p.id,{...a,key:'verify-key-02'}));assert.equal(f.calls.length,2);
});
test('idempotency key cannot be reused for a different payload',async t=>{
  const f=fixture(t);await check(f);
  assert.throws(()=>f.service.start('owner',f.p.id,{type:'review_remaining',key:'check-key-01',revision:1}),/标识/);
});
test('partial search failure preserves real successful results',async t=>{
  const f=fixture(t,{search:async kind=>{if(kind==='global_search')throw new AppError('LIMIT','限额');return [fixtureSource(kind)];}});const item=await check(f);
  const op=await done(f.store,f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id}));
  assert.equal(op.status,'partial');const p=f.store.get(f.p.id,'owner');assert.equal(p.sources.length,1);assert.equal(p.verification[item.id].errors.length,1);
});
test('missing credentials produces no invented evidence',async t=>{
  const f=fixture(t,{status:{model:false,zhihu:false}});const item=await check(f);
  const op=await done(f.store,f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id}));
  assert.equal(op.error.code,'ZHIHU_NOT_CONFIGURED');assert.equal(f.calls.length,0);assert.equal(f.store.get(f.p.id,'owner').sources.length,0);
});
test('cancelled search cannot write late results',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const f=fixture(t,{search:async kind=>{await wait;return [fixtureSource(kind)];}});const item=await check(f);
  const op=f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id});
  await new Promise(r=>setTimeout(r,5));f.service.cancel('owner',op.id);release();await new Promise(r=>setTimeout(r,15));
  assert.equal(f.store.getOp(op.id,'owner').status,'cancelled');assert.equal(f.store.get(f.p.id,'owner').sources.length,0);
});
test('draft edit during search makes results stale',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const f=fixture(t,{search:async kind=>{await wait;return [fixtureSource(kind)];}});const item=await check(f);
  const op=f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id});
  await new Promise(r=>setTimeout(r,5));f.service.edit('owner',f.p.id,text+'我补充了新的背景。',1);release();
  assert.equal((await done(f.store,op)).error.code,'STALE_RESULT');assert.equal(f.store.get(f.p.id,'owner').sources.length,0);
});
test('deleting active project cannot resurrect data',async t=>{
  let release;const wait=new Promise(r=>release=r);
  const f=fixture(t,{search:async kind=>{await wait;return [fixtureSource(kind)];}});const item=await check(f);
  f.service.start('owner',f.p.id,{type:'verify_claim',key:'verify-key-01',revision:1,findingId:item.id});
  await new Promise(r=>setTimeout(r,5));f.service.remove('owner',f.p.id);release();await new Promise(r=>setTimeout(r,15));
  assert.throws(()=>f.store.get(f.p.id,'owner'));assert.equal(f.store.list('owner').length,0);
});
test('wording-only suggestion applies and safely undoes without search',async t=>{
  const f=fixture(t);const item=await check(f);
  assert.throws(()=>f.service.start('owner',f.p.id,{type:'suggest_revision',key:'suggest-key-0',revision:1,findingId:item.id}),/先查看依据/);
  await done(f.store,f.service.start('owner',f.p.id,{type:'suggest_revision',key:'suggest-key-1',revision:1,findingId:item.id,wordingOnly:true}));
  const s=f.store.get(f.p.id,'owner').suggestions[0];const applied=f.service.apply('owner',f.p.id,s.id,1);
  assert.ok(applied.text.includes('是否'));assert.equal(applied.revision,2);assert.equal(f.calls.length,0);
  assert.equal(f.service.undo('owner',f.p.id,2).text,text);
});
test('manual edit after apply prevents destructive undo',async t=>{
  const f=fixture(t);const item=await check(f);
  await done(f.store,f.service.start('owner',f.p.id,{type:'suggest_revision',key:'suggest-key-1',revision:1,findingId:item.id,wordingOnly:true}));
  const p=f.service.apply('owner',f.p.id,f.store.get(f.p.id,'owner').suggestions[0].id,1);
  f.service.edit('owner',p.id,p.text+'新的编辑。',2);assert.throws(()=>f.service.undo('owner',p.id,3),/后续编辑/);
});
// 乐观并发控制必须在数据库层生效：两个写者各自读到同一 revision 后并发提交，
// 只能有一个成功。仅靠应用层先读后写的比较，两次都会通过检查而丢失一次更新。
test('concurrent writers on the same revision cannot both win',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const service=new Service(store,{status:{model:false,zhihu:false}});
  const p=service.create('owner',text);
  const a=store.get(p.id,'owner'), b=store.get(p.id,'owner');   // 两个写者读到相同 revision
  assert.equal(a.revision,b.revision);
  const first=service.saveGuarded({...a,text:'甲写者的修改内容，长度足够通过校验。'},1,'冲突');
  assert.equal(first.revision,2);
  assert.throws(()=>service.saveGuarded({...b,text:'乙写者的修改内容，长度足够通过校验。'},1,'冲突'),
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
    store=new Store(file);assert.equal(store.get('p','a').text,'保留的内容');assert.equal(store.getOp('op','a').error.code,'INTERRUPTED');store.close();
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
