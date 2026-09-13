// Regression tests for deployment invariants.
// No real credentials, user databases, or external providers are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../src/server.mjs';
import { OAuth } from '../src/oauth.mjs';
import { createMemoryStore } from '../src/kv.mjs';
import { RedisStore } from '../src/redis-store.mjs';
import { redisFixture } from './redis-helper.mjs';

const text = '这是一篇用于验证跨实例存储一致性的隔离测试草稿，不含任何真实用户数据。';
async function app(t, oauth, providers = { status: { model: false, zhihu: false } },options={}) {
  const a = createApp({ file: ':memory:', oauth, providers,...options });
  a.server.listen(0, '127.0.0.1');
  await once(a.server, 'listening');
  t.after(async () => { await new Promise(r => a.server.close(r)); a.store.close(); });
  return { ...a, url: `http://127.0.0.1:${a.server.address().port}` };
}

test('shared login and durable draft work across independent HTTP instances', {skip:!process.env.TEST_REDIS_URL},async t => {
  const savedOrigin = process.env.APP_ORIGIN;
  delete process.env.APP_ORIGIN;
  t.after(() => { if (savedOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = savedOrigin; });
  const shared = createMemoryStore();
  const oauthA = new OAuth({}, undefined, Date.now, shared);
  const oauthB = new OAuth({}, undefined, Date.now, shared);
  const cookie = 'a'.repeat(64);
  await shared.set(oauthA.sessionKey(cookie), JSON.stringify({ owner: 'zhihu:audit-user', name: 'Audit' }), 3600);
  const redis=await redisFixture(t);
  const a = await app(t, oauthA,undefined,{store:new RedisStore(redis.kv())}), b = await app(t, oauthB,undefined,{store:new RedisStore(redis.kv())});
  const headers = { cookie: `cognitive_session=${cookie}`, 'content-type': 'application/json' };
  const created = await fetch(`${a.url}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ text }) });
  assert.equal(created.status, 201);
  const p = await created.json();
  const auth = await fetch(`${b.url}/api/auth`, { headers });
  assert.equal((await auth.json()).user.name, 'Audit');
  assert.equal((await fetch(`${a.url}/api/projects/${p.id}`, { headers })).status, 200);
  assert.equal((await fetch(`${b.url}/api/projects/${p.id}`, { headers })).status, 200);
  assert.equal((await (await fetch(`${b.url}/api/projects`, { headers })).json())[0].id,p.id);
});

test('www pages and mutations redirect consistently to the canonical domain', async t => {
  const savedOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://audit.example';
  t.after(() => { if (savedOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = savedOrigin; });
  const a = await app(t, new OAuth({}));
  const headers = { host: 'www.audit.example', origin: 'https://www.audit.example', 'content-type': 'application/json' };
  const request = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request(a.url + path, { method, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end(method === 'POST' ? JSON.stringify({ text }) : undefined);
  });
  assert.equal((await request('/')).status, 308);
  const response = await request('/api/projects', 'POST');
  assert.equal(response.status, 308);
});

test('Vercel rejects missing shared persistence rather than accepting disposable drafts',t=>{
  const old=process.env.VERCEL;process.env.VERCEL='1';
  t.after(()=>{if(old===undefined)delete process.env.VERCEL;else process.env.VERCEL=old;});
  assert.throws(()=>createApp({kv:createMemoryStore()}),e=>e.code==='KV_NOT_CONFIGURED');
});

test('operation response registers the actual completion promise with waitUntil',async t=>{
  let release;const pending=new Promise(r=>release=r);const tasks=[];
  const a=await app(t,new OAuth({}),{status:{model:true,zhihu:false},model:async()=>{await pending;return {items:[]};}},{waitUntil:p=>tasks.push(p)});
  const p=await a.service.create('owner',text);
  const op=await a.service.start('owner',p.id,{type:'quick_check',key:'lifecycle-key',revision:1});
  assert.equal(tasks.length,1);assert.ok(tasks[0] instanceof Promise);
  release();await tasks[0];assert.equal(a.store.getOp(op.id,'owner').status,'succeeded');
});
