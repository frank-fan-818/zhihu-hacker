import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AppError } from './domain.mjs';

// 版本化迁移。此前 schema 只靠 `CREATE TABLE IF NOT EXISTS` 隐式演进：
// 能建表，但改不了已存在的表，也无法回答"这个库现在是什么版本"。
//
// 每条迁移记录校验和：若已应用的迁移文件被改动，启动时直接报错而不是静默跑偏差的 schema。
// 每条迁移单独一个事务，PRAGMA foreign_keys 在事务外开关（SQLite 不允许事务内切换）。

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

function loadMigrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter(name => /^\d{3}-[\w-]+\.sql$/.test(name))
    .sort()
    .map(name => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { version: Number(name.slice(0, 3)), name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    });
}

function ensureLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
}

export function appliedMigrations(db) {
  ensureLedger(db);
  return db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all();
}

// 已应用迁移的校验和必须与文件一致，否则说明历史被改动过。
export function verifyMigrations(db, files = loadMigrationFiles()) {
  const applied = new Map(appliedMigrations(db).map(r => [r.version, r]));
  const drift = [];
  for (const f of files) {
    const seen = applied.get(f.version);
    if (seen && seen.checksum !== f.checksum) drift.push({ version: f.version, name: f.name, expected: seen.checksum, actual: f.checksum });
  }
  if (drift.length) {
    throw new AppError('MIGRATION_DRIFT',
      `已应用的迁移文件被改动：${drift.map(d => d.name).join('、')}。请新增一条迁移，不要修改历史。`, 500);
  }
  return { applied: applied.size, files: files.length, drift };
}

export function migrate(db, { files = loadMigrationFiles(), log = () => {} } = {}) {
  ensureLedger(db);
  verifyMigrations(db, files);
  const applied = new Set(appliedMigrations(db).map(r => r.version));
  let count = 0;
  for (const f of files.filter(x => !applied.has(x.version))) {
    // DDL 期间必须关闭外键：重建表会短暂出现"操作记录指向已删除项目"的中间态。
    // SQLite 的 PRAGMA 在事务内无效，所以放在事务外。
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(f.sql);
      // 收尾时校验外键完整性，有问题就整体回滚，不留半迁移状态
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new AppError('MIGRATION_FK_VIOLATION', `迁移 ${f.name} 后存在 ${violations.length} 条外键违规。`, 500);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(f.version, f.name, f.checksum, new Date().toISOString());
      db.exec('COMMIT');
      log(`已应用 ${f.name}`);
      count++;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return { applied: count, total: files.length };
}

// 迁移健康检查：供 db:doctor 使用
export function migrationStatus(db, files = loadMigrationFiles()) {
  const seen = new Map(appliedMigrations(db).map(r => [r.version, r]));
  return files.map(f => ({
    version: f.version,
    name: f.name,
    applied: seen.has(f.version),
    drift: seen.has(f.version) && seen.get(f.version).checksum !== f.checksum,
    appliedAt: seen.get(f.version)?.applied_at ?? null,
  }));
}

export const migrationsDirectory = MIGRATIONS_DIR;
