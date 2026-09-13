// 线上验收：页面、API、草稿写入、初筛、知乎真实查证、回调路由
//
//   node scripts/verify-live.mjs [代理地址]
//
// 为什么必须走代理：本项目所在网络对 vercel.app 既污染 DNS（所有公共 DNS 都返回
// 无关 IP），也按 SNI 阻断连接（官方 anycast IP 直接 ECONNRESET）。
// Node 的 fetch 又不读 HTTPS_PROXY，所以这里用 undici 的 ProxyAgent 走 CONNECT 隧道，
// DNS 由代理端解析，因此不受本机污染影响。
import { loadUndici, DEFAULT_BASE, DEFAULT_PROXY } from './_shared.mjs';

const BASE = DEFAULT_BASE;
const PROXY = process.argv[2] || DEFAULT_PROXY;
const undici = await loadUndici();
const dispatcher = new undici.ProxyAgent(PROXY);
console.log(`目标：${BASE}\n代理：${PROXY}\n`);

try {
  const probe = await fetch('https://api.github.com/rate_limit', { dispatcher, signal: AbortSignal.timeout(15000) });
  console.log(`代理连通性检查：HTTP ${probe.status}`);
} catch (e) {
  console.error(`代理不可用：${e.cause?.code || e.message}`);
  console.error(`请先启动代理工具并确认 ${PROXY} 在监听，或用参数指定正确端口。`);
  process.exit(1);
}

let cookie = '';
const req = async (path, method = 'GET', body) => {
  const r = await fetch(BASE + path, {
    method, dispatcher, redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json', Origin: BASE } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map(x => x.split(';')[0]).join('; ');
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text, headers: r.headers };
};

console.log('\n=== 1) 首页与静态资源 ===');
for (const p of ['/', '/style.css', '/app.js']) {
  try {
    const r = await req(p);
    console.log(`  ${p.padEnd(12)} HTTP ${r.status}  ${r.text.length}B  ${r.headers.get('content-type')}`);
  } catch (e) { console.log(`  ${p.padEnd(12)} 失败：${e.cause?.code || e.message}`); }
}

console.log('\n=== 2) /api/status（storage 应为 sqlite）===');
const st = await req('/api/status');
console.log(`  HTTP ${st.status}  ${st.text}`);

console.log('\n=== 3) /api/auth（configured 应为 true）===');
const au = await req('/api/auth');
console.log(`  HTTP ${au.status}  ${au.text}`);

console.log('\n=== 4) 创建草稿（验证临时磁盘上的 SQLite 可写、中文不乱码）===');
const draft = '远程办公一定能提高所有人的工作效率。但具体任务类型仍值得仔细讨论，这里需要更多依据。';
const created = await req('/api/projects', 'POST', { text: draft });
console.log(`  HTTP ${created.status}  中文完整=${String(created.json?.text || '').startsWith('远程办公一定能提高')}`);
if (!created.json?.id) { console.log(`  创建失败：${created.text.slice(0, 200)}`); process.exit(1); }

console.log('\n=== 5) 初筛（应命中 1 条强断言）===');
await req('/api/projects/' + created.json.id + '/operations', 'POST', { type: 'quick_check', key: 'live-key-01', revision: 1 });
let proj;
for (let i = 0; i < 60; i++) {
  proj = await req('/api/projects/' + created.json.id);
  if (proj.json?.findings?.length) break;
  await new Promise(r => setTimeout(r, 250));
}
console.log(`  发现数=${proj.json?.findings?.length ?? '?'}  引擎=${proj.json?.lastCheck?.engine}`);
for (const f of proj.json?.findings ?? []) console.log(`    锚点=${JSON.stringify(f.quote)}`);

if (proj.json?.findings?.length) {
  console.log('\n=== 6) 知乎真实查证 ===');
  const op = await req('/api/projects/' + created.json.id + '/operations', 'POST', {
    type: 'verify_claim', key: 'live-key-02', revision: 1, findingId: proj.json.findings[0].id,
  });
  if (op.json?.id) {
    for (let i = 0; i < 80; i++) {
      const r = await req('/api/operations/' + op.json.id);
      if (!['queued', 'running'].includes(r.json?.status)) {
        console.log(`  终态=${r.json.status}`);
        const after = await req('/api/projects/' + created.json.id);
        console.log(`  来源数=${after.json?.sources?.length ?? 0}`);
        for (const s of (after.json?.sources ?? []).slice(0, 3)) console.log(`    [${s.provider}] ${s.title}`);
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } else console.log(`  提交失败 HTTP ${op.status} ${op.text.slice(0, 200)}`);
} else console.log('\n=== 6) 跳过（第 5 步无可查证断言）===');

console.log('\n=== 7) 回调路由（未带 state，预期 303 而非 404）===');
const cb = await req('/auth/zhihu/callback');
console.log(`  HTTP ${cb.status}  location=${cb.headers.get('location')}`);

console.log('\n=== 8) 登录需在浏览器完成 ===');
console.log(`  知乎登记的回调地址应为：${BASE}/auth/zhihu/callback`);
console.log('\n判读：2 中 storage=sqlite、3 中 configured=true、5 命中 1 条、6 有真实来源 => 全部可用。');
