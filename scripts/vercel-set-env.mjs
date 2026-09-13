// 通过 Vercel API 写入生产与预览环境变量（值取自本机 .env，不打印任何密钥）。
//
//   node scripts/vercel-set-env.mjs [域名]
//
// 域名用于派生 APP_ORIGIN 与 ZHIHU_OAUTH_REDIRECT_URI；
// 省略时用 https://zhihu-hacker.vercel.app。改域名意味着知乎登记的回调地址也要同步改。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, readEnvFile } from './_shared.mjs';

const DOMAIN = (process.argv[2] || 'zhihu-hacker.vercel.app').replace(/^https?:\/\//, '').replace(/\/$/, '');
const authFile = join(process.env.APPDATA || '', 'com.vercel.cli', 'Data', 'auth.json');
let auth, link;
try { auth = JSON.parse(readFileSync(authFile, 'utf8')); }
catch { console.error(`读不到 Vercel 凭证（${authFile}）。请先运行 vercel login。`); process.exit(1); }
try { link = JSON.parse(readFileSync(join(repoRoot(), '.vercel', 'project.json'), 'utf8')); }
catch { console.error('读不到 .vercel/project.json。请先运行 vercel link。'); process.exit(1); }

const env = readEnvFile();
const vars = [
  ['APP_ORIGIN', `https://${DOMAIN}`],
  ['ZHIHU_OAUTH_REDIRECT_URI', `https://${DOMAIN}/auth/zhihu/callback`],
  ['ZHIHU_OAUTH_APP_ID', env.ZHIHU_OAUTH_APP_ID],
  ['ZHIHU_OAUTH_APP_KEY', env.ZHIHU_OAUTH_APP_KEY],
  ['ZHIHU_ACCESS_SECRET', env.ZHIHU_ACCESS_SECRET],
  ['MODEL_BASE_URL', env.MODEL_BASE_URL],
  ['MODEL_NAME', env.MODEL_NAME],
  ['MODEL_API_KEY', env.MODEL_API_KEY],
];
for (const [k, v] of vars) if (!v) { console.error(`本机 .env 缺少 ${k}`); process.exit(1); }

const TEAM = `teamId=${link.orgId}`;
const api = async (path, init = {}) => {
  const r = await fetch(`https://api.vercel.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', 'User-Agent': 'cognitive-debugger', ...(init.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// Upstash 集成会自动注入 KV_REST_API_URL / KV_REST_API_TOKEN，无需手工填。
// src/kv.mjs 会优先读 SESSION_STORE_*，其次读那对注入的变量名。
console.log('提示：共享存储由 Vercel 的 Upstash 集成注入，本脚本不设置它。');
console.log('      若未连接 Upstash，登录状态只在单实例内有效。\n');

const existing = await api(`/v9/projects/${link.projectId}/env?${TEAM}`);
if (existing.status !== 200) { console.error(`查询现有变量失败 HTTP ${existing.status}`); process.exit(1); }
const have = new Set((existing.body.envs || []).map(e => e.key));
console.log(`现有变量：${have.size ? [...have].join(', ') : '(无)'}`);

const toCreate = vars.filter(([k]) => !have.has(k));
if (toCreate.length) {
  const res = await api(`/v10/projects/${link.projectId}/env?${TEAM}&upsert=true`, {
    method: 'POST',
    body: JSON.stringify(toCreate.map(([key, value]) => ({ key, value, type: 'encrypted', target: ['production', 'preview'] }))),
  });
  console.log(`\n创建 ${toCreate.length} 个变量：HTTP ${res.status}`);
  if (![200, 201].includes(res.status)) { console.error(JSON.stringify(res.body, null, 1)); process.exit(1); }
  for (const c of res.body.created || []) console.log(`  已创建 ${c.key}`);
  for (const e of res.body.error || []) console.log(`  错误 ${JSON.stringify(e)}`);
} else console.log('\n全部已存在，跳过创建。');

console.log(`\nAPP_ORIGIN = https://${DOMAIN}`);
console.log(`回调地址   = https://${DOMAIN}/auth/zhihu/callback`);
console.log('环境变量修改后需要重新部署才生效。');
