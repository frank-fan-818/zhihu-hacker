// 数据库诊断：迁移状态、完整性、引用完整性、索引与规模
// 用法：npm run db:doctor   （可用 SQLITE_FILE 指定库文件）
import { Store } from './store.mjs';
import { diagnose } from './config.mjs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ephemeralRoot = process.env.SQLITE_DIR || (process.env.VERCEL ? '/tmp' : '');
const defaultFile = ephemeralRoot ? join(ephemeralRoot, 'app.sqlite') : join(root, 'data', 'app.sqlite');
const file = process.env.SQLITE_FILE || defaultFile;

console.log(`数据库文件：${file}`);
console.log(`环境：${process.env.VERCEL ? 'Vercel（临时磁盘，重启即重置）' : '本机'}`);

let store;
try {
  store = new Store(file);
} catch (e) {
  console.error(`\n打开失败：${e.code || ''} ${e.message}`);
  console.error('迁移失败时服务会拒绝启动，这是有意的——避免带着半套 schema 运行。');
  process.exitCode = 1;
  process.exit(1);
}

const d = store.diagnostics();

console.log('\n=== 迁移 ===');
const verify = d.migrationVerification;
for (const m of d.migrations) {
  const mark = m.drift ? '校验和不符!' : m.applied ? '已应用' : '未应用';
  console.log(`  ${String(m.version).padStart(3)}  ${m.name.padEnd(28)} ${mark}${m.appliedAt ? '  ' + m.appliedAt : ''}`);
}
console.log(`  已应用 ${verify.applied}/${verify.files}，历史文件漂移 ${verify.drift.length} 处`);

console.log('\n=== 完整性 ===');
console.log(`  integrity_check     : ${d.integrity}`);
console.log(`  foreign_key_check   : ${d.foreignKeyViolations} 条违规`);
console.log(`  孤儿操作记录        : ${d.orphans}`);
console.log(`  journal_mode        : ${d.journalMode}`);
console.log(`  busy_timeout        : ${d.busyTimeout} ms`);
console.log(`  foreign_keys        : ${d.foreignKeys ? '开启' : '关闭（异常）'}`);

console.log('\n=== 规模 ===');
const total = d.pageCount * d.pageSize;
console.log(`  页面                : ${d.pageCount} × ${d.pageSize}B = ${(total / 1024).toFixed(1)} KiB`);
console.log(`  空闲页              : ${d.freelistCount}`);
console.log(`  projects            : ${d.projects} 行`);
console.log(`  operations          : ${d.operations} 行`);
for (const s of d.operationsByStatus) console.log(`    ${String(s.s).padEnd(12)} ${s.c}`);

console.log('\n=== 索引 ===');
for (const i of d.indices) console.log(`  ${i.tbl_name.padEnd(12)} ${i.name}`);

console.log('\n=== 提示 ===');
const notes = [];
if (!d.foreignKeys) notes.push('foreign_keys 未开启，引用完整性不受保护。');
if (d.foreignKeyViolations) notes.push(`存在 ${d.foreignKeyViolations} 条外键违规，需人工核对。`);
if (d.orphans) notes.push(`存在 ${d.orphans} 条指向已删除项目的操作记录。`);
if (verify.drift.length) notes.push('迁移文件校验和不符：不要修改已应用的迁移，应新增一条。');
if (d.migrations.some(m => !m.applied)) notes.push('有未应用的迁移，重启服务会自动应用。');
if (process.env.VERCEL) notes.push('在 Vercel 上数据库位于 /tmp：每实例私有，冷启动重置，草稿不持久。');
if (!notes.length) notes.push('未发现问题。');
for (const n of notes) console.log(`  · ${n}`);

const cfg = diagnose();
console.log(`\n配置诊断：${cfg.issues.length ? cfg.issues.join('；') : '无问题'}`);
store.close();
