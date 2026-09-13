// 文档入库前的密钥扫描：拿本机 .env 的真实秘密值，在文档里逐个查找，
// 并列出文档中的绝对路径（可能含用户名等隐私信息）。
//
//   node scripts/scan-docs-secrets.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, secretsFromEnv } from './_shared.mjs';

const DOCS = join(repoRoot(), 'docs', 'plans');
const secrets = secretsFromEnv();
console.log(`待查秘密 ${secrets.length} 条：${secrets.map(s => s.key).join(', ') || '(无)'}`);

let files;
try { files = readdirSync(DOCS).filter(f => f.endsWith('.md')); }
catch { console.error(`找不到文档目录：${DOCS}`); process.exit(1); }

let leaked = 0;
for (const f of files) {
  const text = readFileSync(join(DOCS, f), 'utf8');
  for (const s of secrets) {
    if (text.includes(s.value)) { console.log(`  泄露! ${f} 含 ${s.key}`); leaked++; }
  }
}
console.log(leaked === 0
  ? `通过：${files.length} 个文档均不含真实密钥`
  : `发现 ${leaked} 处泄露，必须先处理再入库`);

// 绝对路径里可能带用户名，公开仓库前需要确认。
// 用行扫描而不是复杂正则：只在出现盘符冒号反斜杠时取该行的候选片段。
console.log('\n文档中的绝对路径（需确认是否含隐私信息）：');
const drivePath = /[A-Za-z]:\\[^\s`"）)|]+/g;
for (const f of files) {
  const text = readFileSync(join(DOCS, f), 'utf8');
  const hits = [...new Set(text.match(drivePath) || [])];
  console.log(`  ${f}: ${hits.length ? hits.join('  |  ') : '(无)'}`);
}
process.exit(leaked === 0 ? 0 : 1);
