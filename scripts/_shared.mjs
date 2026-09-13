// 仓库内脚本公用工具
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** 仓库根目录（本文件位于 <root>/scripts/） */
export const repoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 本地数据库文件路径，遵循与 src/server.mjs 相同的选择规则 */
export function databaseFile() {
  if (process.env.SQLITE_FILE) return process.env.SQLITE_FILE;
  const ephemeral = process.env.SQLITE_DIR || (process.env.VERCEL ? '/tmp' : '');
  return ephemeral ? join(ephemeral, 'app.sqlite') : join(repoRoot(), 'data', 'app.sqlite');
}

/** 读取 .env 里的 Key=Value（只解析，不打印值） */
export function readEnvFile(file = join(repoRoot(), '.env')) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// 真正的秘密：排除 _URL / _BASE_URL / _NAME / _HOST / _PORT 这类非敏感配置。
// 与文档校验脚本共用同一规则，避免两处判断不一致。
export const SECRET_KEY_PATTERN = /^(?!.*(_URL|_BASE_URL|_NAME|_HOST|_PORT)$).*(_SECRET|_KEY|_TOKEN|_PASSWORD)$/;

export function secretsFromEnv(env = readEnvFile()) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_KEY_PATTERN.test(k) && v.length > 6)
    .map(([key, value]) => ({ key, value }));
}

/**
 * 载入 undici，用于走代理访问线上部署。
 * 优先用本仓库依赖；其次复用 Vercel CLI 自带的副本，避免为了几个脚本引入运行时依赖。
 */
export async function loadUndici() {
  const candidates = [import.meta.url];
  const globalRoots = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'vercel', 'package.json'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'npm-global', 'node_modules', 'vercel', 'package.json'),
    'C:\\Program Files\\nodejs\\node_modules\\vercel\\package.json',
    // 本机实测的全局安装位置
    'D:\\DeveloperTools\\nodejs\\npm-global\\node_modules\\vercel\\package.json',
  ].filter(Boolean);
  candidates.push(...globalRoots);
  for (const base of candidates) {
    try {
      const resolved = createRequire(base).resolve('undici');
      return await import(pathToFileURL(resolved).href);
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 undici。可执行 npm i -D undici 后重试，或改用浏览器手动验证。');
}

/** 线上验收的目标地址；知乎登记的回调地址必须与此主机一致 */
export const DEFAULT_BASE = process.env.VERIFY_BASE || 'https://zhihu-hacker.vercel.app';
export const DEFAULT_PROXY = process.env.VERIFY_PROXY || 'http://127.0.0.1:7890';
