import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './domain.mjs';
import { migrate, migrationStatus, verifyMigrations } from './migrations.mjs';

// SQLite 是单写者模型：并发写会直接报 SQLITE_BUSY 而不是排队。
// 多实例/多进程共用一个库文件时（例如 Serverless 上同一实例并发请求），
// busy_timeout 让写操作等待而不是立刻失败。
const PRAGMAS = [
  'PRAGMA journal_mode=WAL;',      // 读写并发：读者不阻塞写者
  'PRAGMA busy_timeout=5000;',     // 写锁等待 5s 再报错
  'PRAGMA foreign_keys=ON;',       // 外键约束默认关闭，必须显式开启
  'PRAGMA synchronous=NORMAL;',    // WAL 下的常规取舍：崩溃安全 + 明显更快的写入
];

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    for (const pragma of PRAGMAS) this.db.exec(pragma);
    try {
      migrate(this.db);
    } catch (e) {
      // 迁移失败必须让服务起不来，而不是带着半套 schema 继续跑
      this.db.close();
      throw e instanceof AppError ? e : new AppError('MIGRATION_FAILED', `数据库迁移失败：${e.message}`, 500);
    }
    this.#interruptStaleOperations();
  }

  // 服务重启后，上次未结束的操作标记为中断，保留已有资料，不静默续跑。
  // 只扫未完成的行（有部分索引 idx_operations_unfinished 支撑）。
  #interruptStaleOperations() {
    const rows = this.db.prepare("SELECT data FROM operations WHERE status IN ('queued','running')").all();
    for (const row of rows) {
      const op = JSON.parse(row.data);
      if (['queued', 'running'].includes(op.status)) {
        op.status = 'failed';
        op.error = { code: 'INTERRUPTED', message: '服务已重启，上次任务中断。已有资料已保留。' };
        this.saveOp(op);
      }
    }
  }

  get(project, owner) {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=? AND owner=?').get(project, owner);
    if (!row) throw new AppError('NOT_FOUND', '项目不存在或无法访问。', 404);
    return JSON.parse(row.data);
  }

  save(p) {
    p.updated = new Date().toISOString();
    // 显式列名：表上现在有虚拟生成列，位置参数会错位
    this.db.prepare('INSERT INTO projects (id,owner,updated,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data').run(p.id, p.owner, p.updated, JSON.stringify(p));
    return p;
  }

  // 乐观并发控制下推到数据库：用一条带 revision 条件的 UPDATE 做原子比较并写入。
  // 应用层的先读后写存在检查-使用间隙，两个并发请求可能都通过检查。
  // 返回 null 表示 revision 已变化（谁都没改），由调用方转成 409。
  //
  // 注意：revision 是虚拟生成列，不能直接写入——它由 data 的 $.revision 派生。
  // 所以这里只写 data，revision 列会自动跟随。
  saveIfRevision(p, baseRevision) {
    const next = { ...p, revision: baseRevision + 1, updated: new Date().toISOString() };
    const result = this.db.prepare(
      "UPDATE projects SET data=?, updated=? WHERE id=? AND owner=? AND json_extract(data,'$.revision')=?"
    ).run(JSON.stringify(next), next.updated, next.id, next.owner, baseRevision);
    return Number(result.changes) > 0 ? next : null;
  }

  list(owner) {
    return this.db.prepare('SELECT id, data, updated FROM projects WHERE owner=? ORDER BY updated DESC LIMIT 30').all(owner).map(r => {
      const p = JSON.parse(r.data);
      return { id: p.id, title: p.title, revision: p.revision, updated: r.updated };
    });
  }

  // 只取列表需要的字段，不把整行 JSON 读进 Node 再丢弃。
  // 注意：data 是完整文档，这里仍要读它取 title；若后续有分页需求，
  // 应把 title 提成生成列直接 SELECT，避免读取大文档。
  listLight(owner, limit = 30) {
    return this.db.prepare(
      "SELECT id, updated, json_extract(data,'$.title') title, json_extract(data,'$.revision') revision FROM projects WHERE owner=? ORDER BY updated DESC LIMIT ?"
    ).all(owner, limit);
  }

  delete(project, owner) {
    this.get(project, owner);
    // operations 有 ON DELETE CASCADE，但显式删除可以兼容尚未迁移的库，
    // 也让意图明确（外键开启时两条语句都在同一事务语义下）。
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM operations WHERE project=? AND owner=?').run(project, owner);
      this.db.prepare('DELETE FROM projects WHERE id=? AND owner=?').run(project, owner);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  saveOp(op) {
    this.db.prepare(
      'INSERT INTO operations (id,project,owner,key,type,status,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data'
    ).run(op.id, op.project, op.owner, op.key, op.type ?? null, op.status ?? null, JSON.stringify(op));
  }

  getOp(operation, owner) {
    const row = this.db.prepare('SELECT data FROM operations WHERE id=? AND owner=?').get(operation, owner);
    if (!row) throw new AppError('NOT_FOUND', '任务不存在或无法访问。', 404);
    return JSON.parse(row.data);
  }

  byKey(project, key) {
    const row = this.db.prepare('SELECT data FROM operations WHERE project=? AND key=?').get(project, key);
    return row ? JSON.parse(row.data) : null;
  }

  close() { this.db.close(); }

  transfer(project, from, to) {
    const p = this.get(project, from);
    if (this.list(to).length >= 30) throw new AppError('PROJECT_LIMIT', '账号草稿已达上限，当前匿名草稿未迁移。', 429);
    const ops = this.db.prepare('SELECT data FROM operations WHERE project=?').all(project).map(x => JSON.parse(x.data));
    if (ops.some(x => ['queued', 'running'].includes(x.status))) throw new AppError('BUSY', '当前草稿还有运行任务，请完成后再关联账号。', 409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      p.owner = to;
      this.db.prepare('UPDATE projects SET owner=?,data=? WHERE id=? AND owner=?').run(to, JSON.stringify(p), project, from);
      for (const op of ops) {
        op.owner = to;
        this.db.prepare('UPDATE operations SET owner=?,data=? WHERE id=?').run(to, JSON.stringify(op), op.id);
      }
      this.db.exec('COMMIT');
      return p;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // 供 db:doctor 使用：诊断用统计，不参与业务
  diagnostics() {
    const one = sql => this.db.prepare(sql).get();
    const all = sql => this.db.prepare(sql).all();
    return {
      journalMode: one('PRAGMA journal_mode').journal_mode,
      busyTimeout: one('PRAGMA busy_timeout').timeout,
      foreignKeys: one('PRAGMA foreign_keys').foreign_keys,
      pageCount: one('PRAGMA page_count').page_count,
      pageSize: one('PRAGMA page_size').page_size,
      freelistCount: one('PRAGMA freelist_count').freelist_count,
      integrity: one('PRAGMA integrity_check').integrity_check,
      foreignKeyViolations: all('PRAGMA foreign_key_check').length,
      projects: one('SELECT COUNT(*) c FROM projects').c,
      operations: one('SELECT COUNT(*) c FROM operations').c,
      operationsByStatus: all("SELECT COALESCE(status,'(未知)') s, COUNT(*) c FROM operations GROUP BY s ORDER BY c DESC"),
      orphans: one('SELECT COUNT(*) c FROM operations o LEFT JOIN projects p ON p.id=o.project WHERE p.id IS NULL').c,
      migrations: migrationStatus(this.db),
      migrationVerification: verifyMigrations(this.db),
      indices: all("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name"),
    };
  }
}
