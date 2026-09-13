// Adversarial regression tests. All upstream responses are local fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuth } from '../src/oauth.mjs';
import { createMemoryStore } from '../src/kv.mjs';
import { createApp } from '../src/server.mjs';

const env = { ZHIHU_OAUTH_APP_ID: 'fixture', ZHIHU_OAUTH_APP_KEY: 'fixture',
  APP_ORIGIN: 'https://audit.example', ZHIHU_OAUTH_REDIRECT_URI: 'https://audit.example/auth/zhihu/callback' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const params = (url, code = 'fixture-code') => new URLSearchParams({ state: new URL(url).searchParams.get('state'), authorization_code: code });
const exchange = async url => new Response(JSON.stringify(url.endsWith('/access_token')
  ? { access_token: 'fixture-token', expires_in: 3600 } : { hash_id: 'fixture-user' }));

test('concurrent callbacks consume a state exactly once even with distinct valid provider codes', async () => {
  const memory = createMemoryStore(), bothRead = deferred();
  let stateReads = 0;
  const store = { ...memory, async consume(key) {
    if (++stateReads === 2) bothRead.resolve();
    await bothRead.promise;
    return memory.consume(key);
  } };
  const oauth = new OAuth(env, exchange, Date.now, store);
  const url = await oauth.start('fixture-cookie');
  const results = await Promise.allSettled([
    oauth.finish('fixture-cookie', params(url, 'valid-code-a')),
    oauth.finish('fixture-cookie', params(url, 'valid-code-b')),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'OAUTH_STATE');
  assert.ok(await oauth.session(results.find(r => r.status === 'fulfilled').value.cookie));
});

test('logout before atomic session commit rejects the pending callback', async () => {
  const memory = createMemoryStore(), reachedWrite = deferred(), allowWrite = deferred();
  const store = { ...memory, async commitSession(...args) {
    reachedWrite.resolve();
    await allowWrite.promise;
    return memory.commitSession(...args);
  } };
  const oauth = new OAuth(env, exchange, Date.now, store);
  const url = await oauth.start('fixture-cookie');
  const pending = oauth.finish('fixture-cookie', params(url));
  await reachedWrite.promise;
  await oauth.logout('fixture-cookie');
  allowWrite.resolve();
  await assert.rejects(pending, e => e.code === 'OAUTH_STATE');
  assert.equal(await oauth.logoutEpoch('fixture-cookie'), 1);
});

test('logout after commit revokes the rotated session even if callback response arrives late', async () => {
  const oauth = new OAuth(env, exchange, Date.now, createMemoryStore());
  const result = await oauth.finish('fixture-cookie', params(await oauth.start('fixture-cookie')));
  assert.ok(await oauth.session(result.cookie));
  await oauth.logout('fixture-cookie');
  assert.equal(await oauth.session(result.cookie), null);
});

async function localApp(t) {
  let calls = 0;
  const app = createApp({ file: ':memory:', oauth: new OAuth({}, exchange),
    providers: { status: {}, questions: async () => { calls++; return []; } } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => app.server.close(r)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { calls: () => calls, async request(path, cookie, method = 'POST', body = {}, extra = {}) {
    return fetch(base + path, { method, headers: { cookie, host: process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).host : new URL(base).host,
      'Content-Type': 'application/json', ...extra }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  } };
}

test('rotating anonymous cookie cannot bypass the IP request budget', async t => {
  const app = await localApp(t);
  const session = 'cognitive_session=' + 'a'.repeat(64);
  for (let i = 0; i < 20; i++) assert.equal((await app.request('/api/questions', session, 'POST', { query: 'fixture' })).status, 200);
  assert.equal((await app.request('/api/questions', session, 'POST', { query: 'fixture' })).status, 429);
  const rotated = session + '; cognitive_anonymous=' + 'b'.repeat(64);
  assert.equal((await app.request('/api/questions', rotated, 'POST', { query: 'fixture' })).status, 429);
  assert.equal(app.calls(), 20);
});

test('AUDIT control: anonymous project ownership and explicit cross-site writes are rejected', async t => {
  const app = await localApp(t);
  const owner = 'cognitive_session=' + 'c'.repeat(64), stranger = 'cognitive_session=' + 'd'.repeat(64);
  const created = await app.request('/api/projects', owner, 'POST', { text: '这是一篇用于验证匿名草稿访问隔离的本地测试内容。' });
  assert.equal(created.status, 201);
  const project = await created.json();
  assert.equal((await app.request('/api/projects/' + project.id, stranger, 'GET')).status, 404);
  assert.equal((await app.request('/api/projects/' + project.id, stranger, 'DELETE')).status, 404);
  assert.equal((await app.request('/api/questions', owner, 'POST', {}, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await app.request('/api/questions', owner, 'POST', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
});
