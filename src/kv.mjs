import { AppError } from './domain.mjs';

// 键值存储抽象：OAuth state、登录会话与限流计数必须活过单个进程。
// 本地开发用内存实现；部署到 Serverless 时用 Upstash Redis REST 实现。
// 不引入第三方依赖，Redis 适配器直接调用 REST 接口。

// 内存实现：单进程有效。带 TTL 语义，便于本地开发与测试保持与 Redis 一致的行为。
export function createMemoryStore(now = Date.now) {
  const data = new Map();
  const alive = entry => entry && entry.expires > now();
  const read = key => {
    const entry = data.get(key);
    if (!alive(entry)) { data.delete(key); return null; }
    return entry.value;
  };
  return {
    kind: 'memory',
    async get(key) { return read(key); },
    async set(key, value, ttlSeconds) {
      data.set(key, { value, expires: now() + Math.max(1, ttlSeconds) * 1000 });
    },
    async del(...keys) { let n = 0; for (const key of keys) if (data.delete(key)) n++; return n; },
    async delByPrefix(prefix) {
      let n = 0;
      for (const key of [...data.keys()]) if (key.startsWith(prefix) && data.delete(key)) n++;
      return n;
    },
    async incr(key, ttlSeconds) {
      const current = Number(read(key)) || 0;
      const next = current + 1;
      const existing = data.get(key);
      const expires = alive(existing) ? existing.expires : now() + Math.max(1, ttlSeconds) * 1000;
      data.set(key, { value: String(next), expires });
      return next;
    },
    // 仅测试使用：清空全部键。
    async clear() { data.clear(); },
  };
}

// Upstash Redis REST 实现。请求形如 POST {url}  body ["GET", key]。
// 只允许 Redis 单命令数组，不执行用户提供的任意命令。
export function createRedisStore({ url, token, prefix = 'cd:', fetcher = fetch } = {}) {
  if (!url || !token) throw new AppError('KV_NOT_CONFIGURED', '键值存储缺少 URL 或 Token。');
  const namespaced = key => `${prefix}${key}`;
  const command = async (...args) => {
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args.map(String)),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new AppError('KV_UNAVAILABLE', '登录状态存储暂时不可用，请稍后重试。', 503);
    }
    if (!response.ok) throw new AppError('KV_UNAVAILABLE', `登录状态存储返回 HTTP ${response.status}。`, 503);
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || 'error' in payload) throw new AppError('KV_UNAVAILABLE', '登录状态存储响应无效。', 503);
    return payload.result;
  };
  return {
    kind: 'redis',
    async get(key) { const value = await command('GET', namespaced(key)); return value === null || value === undefined ? null : String(value); },
    async set(key, value, ttlSeconds) { await command('SET', namespaced(key), String(value), 'EX', Math.max(1, Math.ceil(ttlSeconds))); },
    async del(...keys) {
      const list = keys.map(namespaced);
      if (!list.length) return 0;
      return Number(await command('DEL', ...list)) || 0;
    },
    async delByPrefix(prefixMatch) {
      const match = `${prefix}${prefixMatch}*`;
      let cursor = '0';
      let removed = 0;
      do {
        const page = await command('SCAN', cursor, 'MATCH', match, 'COUNT', 200);
        if (!Array.isArray(page) || page.length !== 2) throw new AppError('KV_UNAVAILABLE', '登录状态存储扫描响应无效。', 503);
        cursor = String(page[0]);
        const keys = Array.isArray(page[1]) ? page[1] : [];
        // SCAN 返回的是已经带命名空间的完整键，必须原样删除，不能再走 del() 二次加前缀。
        if (keys.length) removed += Number(await command('DEL', ...keys)) || 0;
      } while (cursor !== '0');
      return removed;
    },
    async incr(key, ttlSeconds) {
      const name = namespaced(key);
      const value = Number(await command('INCR', name));
      if (value === 1) await command('EXPIRE', name, Math.max(1, Math.ceil(ttlSeconds)));
      return value;
    },
  };
}

// 共享存储的连接信息可以来自两种来源，按优先级取第一组齐全的：
//   1. 本项目自定义的 SESSION_STORE_URL / SESSION_STORE_TOKEN
//   2. Vercel Upstash 集成自动注入的 KV_REST_API_URL / KV_REST_API_TOKEN
// 必须支持第 2 种：平台注入的名字不受本项目控制，改名字不如适配名字。
const READ_WRITE_CREDENTIALS = [
  ['SESSION_STORE_URL', 'SESSION_STORE_TOKEN'],
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
];

function resolveCredentials(env) {
  for (const [urlKey, tokenKey] of READ_WRITE_CREDENTIALS) {
    if (env[urlKey] && env[tokenKey]) return { url: env[urlKey], token: env[tokenKey], urlKey, tokenKey };
  }
  // 记录只配了一半的情况，便于诊断给出准确提示
  for (const [urlKey, tokenKey] of READ_WRITE_CREDENTIALS) {
    if (env[urlKey] || env[tokenKey]) return { incomplete: `${urlKey} 与 ${tokenKey}` };
  }
  return {};
}

export function createStore(env = process.env, options = {}) {
  const found = resolveCredentials(env);
  if (found.url && found.token) return createRedisStore({ url: found.url, token: found.token, prefix: env.SESSION_STORE_PREFIX || 'cd:', ...options });
  return createMemoryStore(options.now);
}

export function storeStatus(env = process.env) {
  const found = resolveCredentials(env);
  if (found.url && found.token) return { kind: 'redis', durable: true, credentials: found.tokenKey };
  if (found.incomplete) return { kind: 'memory', durable: false, issue: `键值存储配置不完整：${found.incomplete} 需要同时提供。` };
  return { kind: 'memory', durable: false, issue: '未配置共享键值存储：登录状态仅在单实例内有效，Serverless 多实例下登录会失败。' };
}
