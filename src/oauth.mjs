import { randomBytes } from 'node:crypto';
import { AppError, hash } from './domain.mjs';
import { diagnose } from './config.mjs';
import { createStore } from './kv.mjs';

const random = () => randomBytes(32).toString('hex');
const STATE_TTL = 300;        // state 与登录请求的有效期（秒）
const EPOCH_TTL = 604800;     // logout 代号保留期，覆盖最长会话

// 登录状态（待处理 state、登录会话、logout 代号）全部放进键值存储，
// 不再放进程内存——Serverless 上 start 与 callback 可能落在不同实例。
//
// state 通过原子读取并删除认领；会话提交和撤销使用存储原子操作。
// 取消只由 logout 承担：推进 logout 代号让在途交换与后续回调全部失效。
// 这里刻意不记录"当前登录代号"——否则重复发起登录会让先前那次授权失效，
// 用户完成的恰好是被作废的那次，回调必然失败（线上真实故障）。
export class OAuth {
  constructor(env = process.env, fetcher = fetch, now = Date.now, store = null) {
    this.env = env;
    this.fetcher = fetcher;
    this.now = now;
    this.store = store || createStore(env, { now });
  }

  get configured() { return diagnose(this.env).oauth; }

  stateKey(state) { return `oauth:state:${state}`; }
  sessionKey(cookie) { return `oauth:session:${hash(cookie)}`; }
  logoutEpochKey(cookie) { return `oauth:logout:${hash(cookie)}`; }

  async logoutEpoch(cookie) { return Number(await this.store.get(this.logoutEpochKey(cookie))) || 0; }

  // 发起登录：绑定当前匿名会话，签发一次性的随机 state。
  // 多个待处理登录可以并存，互不影响。
  async start(cookie, projectId = null, anonymousOwner = hash(cookie)) {
    if (!this.configured) throw new AppError('OAUTH_NOT_CONFIGURED', '知乎登录尚未配置，匿名草稿仍可继续使用。', 503);
    const key = hash(cookie);
    const state = `${key}:${random()}`;
    await this.store.set(this.stateKey(state), JSON.stringify({ key, projectId, anonymousOwner }), STATE_TTL);
    const url = new URL('https://openapi.zhihu.com/authorize');
    for (const [k, v] of Object.entries({ app_id: this.env.ZHIHU_OAUTH_APP_ID, redirect_uri: this.env.ZHIHU_OAUTH_REDIRECT_URI, response_type: 'code', state })) url.searchParams.set(k, v);
    return url.href;
  }

  async session(cookie) {
    const raw = await this.store.get(this.sessionKey(cookie));
    if (!raw) return null;
    let session;
    try { session = JSON.parse(raw); } catch { return null; }
    if (!session || session.expires <= this.now()) return null;
    // 原 callback 的 cookie 可能在响应到达之前退出，轮换后的会话仍须可撤销。
    if (session.revokeKey && Number(await this.store.get(session.revokeKey)) > 0) return null;
    const { revokeKey, ...publicSession } = session;
    return publicSession;
  }

  // 退出：清除会话、作废本会话待处理登录、推进 logout 代号使在途交换失败。
  async logout(cookie) {
    await this.store.revokeSession(this.logoutEpochKey(cookie), this.sessionKey(cookie), EPOCH_TTL);
  }

  async json(url, options) {
    const r = await this.fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new AppError('OAUTH_FAILED', `知乎授权服务请求失败（HTTP ${r.status}）。`, 502);
    const text = await r.text();
    if (text.length > 100000) throw new AppError('OAUTH_FAILED', '授权响应过大。', 502);
    try { return JSON.parse(text, (key, value, context) => key === 'uid' && typeof value === 'number' ? context.source : value); }
    catch { throw new AppError('OAUTH_FAILED', '授权响应格式无效。', 502); }
  }

  async finish(cookie, params) {
    const state = params.get('state');
    const key = hash(cookie);
    const expired = () => new AppError('OAUTH_STATE', '登录请求已失效或不匹配，请重新发起登录。', 400);
    if (!state || !state.startsWith(`${key}:`)) throw expired();
    const raw = await this.store.consume(this.stateKey(state));
    if (!raw) throw expired();
    let pending;
    try { pending = JSON.parse(raw); } catch { throw expired(); }
    // state 与会话绑定：换一个浏览器带同一个 state 回来必须失败。
    if (pending.key !== key) throw expired();
    if (await this.logoutEpoch(cookie) > 0) throw expired();

    const code = params.get('authorization_code');
    if (!code || code.length > 4096) throw new AppError('OAUTH_CODE', '未取得有效授权码，请重新登录。');
    const token = await this.json('https://openapi.zhihu.com/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ app_id: this.env.ZHIHU_OAUTH_APP_ID, app_key: this.env.ZHIHU_OAUTH_APP_KEY, grant_type: 'authorization_code', redirect_uri: this.env.ZHIHU_OAUTH_REDIRECT_URI, code }).toString(),
    });
    const t = token.access_token ? token : token.data;
    if (typeof t?.access_token !== 'string' || !t.access_token || !Number.isFinite(t.expires_in) || t.expires_in <= 0) throw new AppError('OAUTH_FAILED', '未取得有效登录令牌。', 502);
    const rawUser = await this.json('https://openapi.zhihu.com/user', { headers: { Authorization: `Bearer ${t.access_token}` } });
    const user = rawUser.hash_id || rawUser.uid ? rawUser : rawUser.data;
    const uid = typeof user?.hash_id === 'string' && user.hash_id ? user.hash_id : typeof user?.uid === 'string' && /^\d+$/.test(user.uid) ? user.uid : null;
    if (!uid) throw new AppError('OAUTH_FAILED', '未取得有效用户身份。', 502);

    const nextCookie = random();
    const ttl = Math.min(t.expires_in, 604800);
    const session = { owner: 'zhihu:' + hash(uid), name: String(user.fullname || '知乎用户').slice(0, 100), expires: this.now() + ttl * 1000 };
    // 本里程碑不调用用户数据接口，取到身份后即丢弃提供方 Token。
    const committed = await this.store.commitSession(this.logoutEpochKey(cookie), this.sessionKey(nextCookie),
      this.sessionKey(cookie), JSON.stringify({ ...session, revokeKey: this.logoutEpochKey(cookie) }), ttl);
    if (!committed) throw new AppError('OAUTH_STATE', '登录已取消。', 400);
    return { cookie: nextCookie, session, projectId: pending.projectId, previousOwner: pending.anonymousOwner };
  }
}
