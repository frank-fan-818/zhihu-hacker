import { randomBytes } from 'node:crypto';
import { AppError, hash } from './domain.mjs';
import { diagnose } from './config.mjs';
import { createStore } from './kv.mjs';

const random = () => randomBytes(32).toString('hex');
const STATE_TTL = 300;        // state 与登录请求的有效期（秒）
const EPOCH_TTL = 604800;     // logout 代号保留期，覆盖最长会话

// 登录状态（待处理 state、登录会话、logout 代号）全部放进键值存储，
// 不再放进程内存——Serverless 上 start 与 callback 可能落在不同实例。
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
  epochKey(cookie) { return `oauth:epoch:${hash(cookie)}`; }

  async epochFor(cookie) { return Number(await this.store.get(this.epochKey(cookie))) || 0; }

  // 发起登录：绑定当前匿名会话，签发一次性的随机 state。
  async start(cookie, projectId = null, anonymousOwner = hash(cookie)) {
    if (!this.configured) throw new AppError('OAUTH_NOT_CONFIGURED', '知乎登录尚未配置，匿名草稿仍可继续使用。', 503);
    const key = hash(cookie);
    // 同一会话重新发起登录：作废旧 state 并推进代号，之前那次授权随即失效。
    await this.store.delByPrefix(`oauth:state:${key}:`);
    const epoch = await this.store.incr(this.epochKey(`${cookie}:login`), EPOCH_TTL);
    const state = `${key}:${epoch}:${random()}`;
    await this.store.set(this.stateKey(state), JSON.stringify({ key, projectId, anonymousOwner, generation: epoch }), STATE_TTL);
    const url = new URL('https://openapi.zhihu.com/authorize');
    for (const [k, v] of Object.entries({ app_id: this.env.ZHIHU_OAUTH_APP_ID, redirect_uri: this.env.ZHIHU_OAUTH_REDIRECT_URI, response_type: 'code', state })) url.searchParams.set(k, v);
    return url.href;
  }

  async session(cookie) {
    const raw = await this.store.get(this.sessionKey(cookie));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // 退出：清除会话、作废待处理登录、推进 logout 代号使在途交换失败。
  async logout(cookie) {
    const key = hash(cookie);
    await this.store.del(this.sessionKey(cookie));
    await this.store.delByPrefix(`oauth:state:${key}:`);
    await this.store.incr(this.epochKey(`${cookie}:logout`), EPOCH_TTL);
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
    const raw = state ? await this.store.get(this.stateKey(state)) : null;
    if (!raw) throw new AppError('OAUTH_STATE', '登录请求已失效或不匹配，请重新发起登录。', 400);
    let pending;
    try { pending = JSON.parse(raw); } catch { throw new AppError('OAUTH_STATE', '登录请求已失效或不匹配，请重新发起登录。', 400); }
    // state 与会话绑定：换一个浏览器带同一个 state 回来必须失败。
    if (pending.key !== key) throw new AppError('OAUTH_STATE', '登录请求已失效或不匹配，请重新发起登录。', 400);
    // 单次消费：先删除再交换，重放会被上面查不到拦住。
    await this.store.del(this.stateKey(state));

    const epoch = await this.store.get(this.epochKey(`${cookie}:login`));
    if (Number(epoch) !== Number(pending.generation)) throw new AppError('OAUTH_STATE', '登录已取消。', 400);

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

    // 交换期间发生 logout 或重新发起登录：放弃本次结果，不建立会话。
    const logoutEpoch = await this.epochFor(`${cookie}:logout`);
    const nowEpoch = await this.store.get(this.epochKey(`${cookie}:login`));
    if (Number(nowEpoch) !== Number(pending.generation) || logoutEpoch > 0) throw new AppError('OAUTH_STATE', '登录已取消。', 400);

    const nextCookie = random();
    const ttl = Math.min(t.expires_in, 604800);
    const session = { owner: 'zhihu:' + hash(uid), name: String(user.fullname || '知乎用户').slice(0, 100), expires: this.now() + ttl * 1000 };
    // 本里程碑不调用用户数据接口，取到身份后即丢弃提供方 Token。
    await this.store.set(this.sessionKey(nextCookie), JSON.stringify(session), ttl);
    await this.store.del(this.sessionKey(cookie));
    await this.store.delByPrefix(`oauth:state:${key}:`);
    return { cookie: nextCookie, session, projectId: pending.projectId, previousOwner: pending.anonymousOwner };
  }
}
