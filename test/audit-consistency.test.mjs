// Regression tests for production invariants, including controlled competing commits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { Service } from '../src/service.mjs';

const text='远程办公一定能提高所有人的工作效率。所有人必然喜欢弹性安排。具体任务类型仍值得仔细讨论。';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function cleanup(dir,prefix){
  const target=resolve(dir);
  assert.equal(dirname(target),resolve(tmpdir()));
  assert.ok(basename(target).startsWith(prefix));
  rmSync(target,{recursive:true,force:true});
}
async function setup(t,providers={status:{model:false,zhihu:false}}){
  const store=new Store(':memory:');
  const service=new Service(store,providers);
  t.after(()=>store.close());
  return {store,service,p:await service.create('owner',text)};
}
async function run(f,type,args={}){
  const op=await f.service.start('owner',f.p.id,{type,key:`audit-${Math.random()}`,revision:f.store.get(f.p.id,'owner').revision,...args});
  for(let i=0;i<100;i++){
    await tick();
    const current=f.store.getOp(op.id,'owner');
    if(!['queued','running'].includes(current.status))return current;
  }
  throw new Error('audit operation did not terminate');
}

test('deferring preserves text revision and other findings',async t=>{
  const f=await setup(t); await run(f,'review_remaining');
  const before=f.store.get(f.p.id,'owner'); assert.equal(before.findings.length,2);
  const after=await f.service.defer('owner',f.p.id,before.findings[0].id,1);
  assert.equal(after.text,before.text);
  assert.equal(after.revision,1);
  assert.equal((await run(f,'suggest_revision',{findingId:before.findings[1].id,wordingOnly:true})).status,'succeeded');
  await run(f,'review_remaining');
  assert.equal(f.store.get(f.p.id,'owner').findings[0].status,'deferred');
});

test('opening a second store leaves healthy tasks running',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'cognitive-audit-'));
  const file=join(dir,'audit.sqlite');
  const first=new Store(file);let second;
  t.after(()=>{second?.close();first.close();cleanup(dir,'cognitive-audit-');});
  let release;
  const gate=new Promise(resolve=>release=resolve);
  const service=new Service(first,{status:{model:true,zhihu:false},model:async()=>{await gate;return {items:[]};}});
  const p=await service.create('owner',text);
  const op=await service.start('owner',p.id,{type:'quick_check',key:'audit-live-task',revision:1});
  await tick();assert.equal(first.getOp(op.id,'owner').status,'running');
  second=new Store(file);
  assert.equal(first.getOp(op.id,'owner').status,'running');
  release();await tick();
  assert.equal(first.getOp(op.id,'owner').status,'succeeded');
  assert.ok(first.get(p.id,'owner').lastCheck);
});

test('atomic result commit preserves an edit after checkpoint',async t=>{
  const f=await setup(t);
  const commit=f.store.commitResult.bind(f.store);
  let edited=false;
  // Deterministic scheduling seam: a second process may commit here because the
  // final checkpoint and UPSERT are separate SQL statements/transactions.
  f.store.commitResult=async(p,op,version)=>{
    if(!edited){edited=true;await f.service.edit('owner',p.id,text+'用户已经成功保存的新段落。',1);}
    return commit(p,op,version);
  };
  assert.equal((await run(f,'quick_check')).error.code,'STALE_RESULT');
  const after=f.store.get(f.p.id,'owner');
  assert.equal(after.text,text+'用户已经成功保存的新段落。');
  assert.equal(after.revision,2);
});

test('read-only db-doctor leaves healthy tasks running',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'cognitive-doctor-audit-'));
  const file=join(dir,'audit.sqlite');
  const store=new Store(file);
  t.after(()=>{store.close();cleanup(dir,'cognitive-doctor-audit-');});
  let release;
  const gate=new Promise(resolve=>release=resolve);
  const service=new Service(store,{status:{model:true,zhihu:false},model:async()=>{await gate;return {items:[]};}});
  const p=await service.create('owner',text);
  const op=await service.start('owner',p.id,{type:'quick_check',key:'audit-doctor-live',revision:1});
  await tick();assert.equal(store.getOp(op.id,'owner').status,'running');
  // No --env-file and explicit child env: never touch developer .env or providers.
  const result=spawnSync(process.execPath,['src/db-doctor.mjs'],{cwd:new URL('..',import.meta.url),env:{SystemRoot:process.env.SystemRoot,SQLITE_FILE:file},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(store.getOp(op.id,'owner').status,'running');
  release();await tick();
  assert.equal(store.getOp(op.id,'owner').status,'succeeded');
});

test('atomic result commit cannot resurrect a deleted project',async t=>{
  const f=await setup(t);
  const commit=f.store.commitResult.bind(f.store);
  let removed=false;
  f.store.commitResult=async(p,op,version)=>{
    if(!removed){removed=true;f.store.delete(p.id,'owner');}
    return commit(p,op,version);
  };
  await assert.rejects(()=>run(f,'quick_check'),e=>e.code==='NOT_FOUND');
  assert.throws(()=>f.store.get(f.p.id,'owner'),e=>e.code==='NOT_FOUND');
});

test('result commit merges a concurrent metadata change without losing deferred status',async t=>{
  const f=await setup(t);await run(f,'quick_check');
  const finding=f.store.get(f.p.id,'owner').findings[0];
  const commit=f.store.commitResult.bind(f.store);let injected=false;
  f.store.commitResult=async(p,op,version)=>{
    if(!injected){injected=true;await f.service.defer('owner',p.id,finding.id,1);}
    return commit(p,op,version);
  };
  assert.equal((await run(f,'quick_check')).status,'succeeded');
  assert.equal(f.store.get(f.p.id,'owner').findings[0].status,'deferred');
});
