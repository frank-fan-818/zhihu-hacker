// 通过 Vercel API 触发生产部署并轮询到 READY。
//
//   node scripts/vercel-deploy.mjs <git-ref>
//
// <git-ref> 可以是分支名、标签或提交 SHA。项目已连接 GitHub 仓库，
// 因此不需要用 Vercel CLI 上传文件，也就不需要 CLI 能写 %APPDATA%。
// 凭证读取位置与 Vercel CLI 相同。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './_shared.mjs';

const ref = process.argv[2];
if (!ref) {
  console.error('用法：node scripts/vercel-deploy.mjs <分支|标签|提交SHA>');
  process.exit(1);
}

const authFile = join(process.env.APPDATA || '', 'com.vercel.cli', 'Data', 'auth.json');
const linkFile = join(repoRoot(), '.vercel', 'project.json');
let auth, link;
try { auth = JSON.parse(readFileSync(authFile, 'utf8')); }
catch { console.error(`读不到 Vercel 凭证（${authFile}）。请先运行 vercel login。`); process.exit(1); }
try { link = JSON.parse(readFileSync(linkFile, 'utf8')); }
catch { console.error(`读不到项目关联（${linkFile}）。请先在项目里运行 vercel link。`); process.exit(1); }

const { projectId, orgId, projectName } = link;
const TEAM = `teamId=${orgId}`;
const api = async (path, init = {}) => {
  const r = await fetch(`https://api.vercel.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', 'User-Agent': 'cognitive-debugger', ...(init.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log(`触发部署：${projectName} @ ${ref}`);
const created = await api(`/v13/deployments?${TEAM}&forceNew=1`, {
  method: 'POST',
  body: JSON.stringify({
    name: projectName,
    project: projectId,
    target: 'production',
    gitSource: { type: 'github', org: 'frank-fan-818', repo: 'zhihu-hacker', ref },
  }),
});
if (![200, 201].includes(created.status)) {
  console.error(`HTTP ${created.status}`);
  console.error(JSON.stringify(created.body, null, 1));
  process.exit(1);
}
const dep = created.body;
console.log(`  id  : ${dep.id}\n  url : https://${dep.url}\n`);

let last = '';
for (let i = 0; i < 90; i++) {
  const r = await api(`/v13/deployments/${dep.id}?${TEAM}`);
  if (r.status !== 200) { console.log(`  查询失败 HTTP ${r.status}`); break; }
  const state = r.body.readyState || r.body.status;
  if (state !== last) { console.log(`  [${new Date().toISOString().slice(11, 19)}] ${state}`); last = state; }
  if (['READY', 'ERROR', 'CANCELED'].includes(state)) {
    console.log(`\n最终状态：${state}`);
    if (r.body.alias?.length) console.log(`别名：${r.body.alias.map(a => 'https://' + a).join(', ')}`);
    if (state === 'ERROR') {
      const ev = await api(`/v3/deployments/${dep.id}/events?${TEAM}&limit=40`);
      if (Array.isArray(ev.body)) for (const e of ev.body.slice(-25)) console.log(`  ${e.type}: ${e.text || ''}`);
      process.exit(1);
    }
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 5000));
}
console.log('轮询超时，请到 Vercel 控制台查看。');
process.exit(1);
