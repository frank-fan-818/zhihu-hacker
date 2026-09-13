// 只读检视数据库：表结构、行数、隔离分组、操作状态、WAL 统计
//
//   node scripts/inspect-db.mjs [库文件路径]
//
// 只读打开，不会修改数据。默认路径与 src/server.mjs 的选择规则一致。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { databaseFile } from './_shared.mjs';

const FILE = process.argv[2] || databaseFile();
console.log(`数据库文件：${FILE}`);

if (!existsSync(FILE)) {
  console.error('文件不存在。本地先 npm start 生成 data/app.sqlite，或用参数指定路径。');
  process.exit(1);
}

console.log('\n=== 文件情况 ===');
for (const suffix of ['', '-wal', '-shm']) {
  const p = FILE + suffix;
  if (existsSync(p)) console.log(`  ${(suffix || '(主库)').padEnd(7)} ${String(statSync(p).size).padStart(9)} 字节`);
}
console.log('  注意：数据可能大量停留在 -wal 里。备份必须三个文件一起复制，');
console.log('        否则只拷主库会得到空数据。');

const db = new DatabaseSync(FILE);

console.log('\n=== 表结构 ===');
for (const t of db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
  console.log(`  ${t.name}: ${t.sql.replace(/\s+/g, ' ')}`);
}
const idx = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name").all();
console.log(`\n=== 索引（${idx.length} 个）===`);
for (const i of idx) console.log(`  ${i.tbl_name.padEnd(12)} ${i.name}`);

console.log('\n=== 数据量 ===');
for (const t of ['projects', 'operations']) {
  console.log(`  ${t.padEnd(12)} ${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c} 行`);
}

console.log('\n=== 按 owner 分组（owner 是隔离键）===');
for (const t of ['projects', 'operations']) {
  const rows = db.prepare(`SELECT owner, COUNT(*) c FROM ${t} GROUP BY owner ORDER BY c DESC LIMIT 10`).all();
  console.log(`  ${t}:`);
  if (!rows.length) console.log('    (空)');
  for (const r of rows) console.log(`    ${r.owner.slice(0, 24)}…  ${r.c} 行`);
}

console.log('\n=== 最近 5 个草稿（摘要）===');
const ps = db.prepare('SELECT updated, data FROM projects ORDER BY updated DESC LIMIT 5').all();
if (!ps.length) console.log('  (无草稿)');
for (const p of ps) {
  const d = JSON.parse(p.data);
  console.log(`  ${p.updated.slice(0, 19)}  rev=${d.revision}  findings=${(d.findings || []).length}  sources=${(d.sources || []).length}  ${JSON.stringify(String(d.text).slice(0, 28))}`);
}

console.log('\n=== 操作状态分布 ===');
const ops = db.prepare("SELECT COALESCE(status, json_extract(data,'$.status')) s, COUNT(*) c FROM operations GROUP BY s ORDER BY c DESC").all();
if (!ops.length) console.log('  (无操作记录)');
for (const o of ops) console.log(`  ${String(o.s).padEnd(12)} ${o.c} 行`);

console.log('\n=== 完整性 ===');
console.log(`  integrity_check   : ${db.prepare('PRAGMA integrity_check').get().integrity_check}`);
console.log(`  foreign_key_check : ${db.prepare('PRAGMA foreign_key_check').all().length} 条违规`);
console.log(`  journal_mode      : ${db.prepare('PRAGMA journal_mode').get().journal_mode}`);
console.log(`  page_count × size : ${db.prepare('PRAGMA page_count').get().page_count} × ${db.prepare('PRAGMA page_size').get().page_size}B`);

db.close();
