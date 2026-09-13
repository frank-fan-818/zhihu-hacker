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
  constructor(file, { readOnly = false } = {}) {
    this.readOnly = readOnly;
    if (!readOnly && file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { readOnly });
    for (const pragma of readOnly ? ['PRAGMA busy_timeout=5000;', 'PRAGMA foreign_keys=ON;'] : PRAGMAS) this.db.exec(pragma);
    try {
      if (!readOnly) migrate(this.db);
    } catch (e) {
      // 迁移失败必须让服务起不来，而不是带着半套 schema 继续跑
      this.db.close();
      throw e instanceof AppError ? e : new AppError('MIGRATION_FAILED', `数据库迁移失败：${e.message}`, 500);
    }
  }

  // 服务重启后，上次未结束的操作标记为中断，保留已有资料，不静默续跑。
  // 只扫未完成的行（有部分索引 idx_operations_unfinished 支撑）。
  recoverInterruptedOperations({ exclusive = false } = {}) {
    if (!exclusive) throw new AppError('EXCLUSIVE_REQUIRED', '恢复操作前必须确认没有其他服务实例运行。', 409);
    const rows = this.db.prepare("SELECT data FROM operations WHERE status IN ('queued','running')").all();
    for (const row of rows) {
      const op = JSON.parse(row.data);
      if (['queued', 'running'].includes(op.status)) {
        op.status = 'failed';
        op.error = { code: 'INTERRUPTED', message: '服务已重启，上次任务中断。已有资料已保留。' };
        this.updateOp(op);
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

  create(p) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.list(p.owner).length >= 30) throw new AppError('PROJECT_LIMIT', '最多保留 30 个项目，请先删除不需要的项目。', 429);
      const next = { ...p, version: 1, updated: new Date().toISOString() };
      this.db.prepare('INSERT INTO projects (id,owner,updated,data) VALUES(?,?,?,?)').run(next.id,next.owner,next.updated,JSON.stringify(next));
      this.db.exec('COMMIT');
      return next;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // 乐观并发控制下推到数据库：用一条带 revision 条件的 UPDATE 做原子比较并写入。
  // 应用层的先读后写存在检查-使用间隙，两个并发请求可能都通过检查。
  // 返回 null 表示 revision 已变化（谁都没改），由调用方转成 409。
  //
  // 注意：revision 是虚拟生成列，不能直接写入——它由 data 的 $.revision 派生。
  // 所以这里只写 data，revision 列会自动跟随。
  saveIfRevision(p, baseRevision, { preserveRevision = false } = {}) {
    const next = { ...p, revision: baseRevision + (preserveRevision ? 0 : 1), version: (p.version ?? 0) + 1, updated: new Date().toISOString() };
    const result = this.db.prepare(
      "UPDATE projects SET data=?, updated=? WHERE id=? AND owner=? AND json_extract(data,'$.revision')=? AND COALESCE(json_extract(data,'$.version'),0)=?"
    ).run(JSON.stringify(next), next.updated, next.id, next.owner, baseRevision, p.version ?? 0);
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

  createOp(op) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const p = this.get(op.project, op.owner);
      const previous = this.byKey(op.project, op.key, op.owner);
      if (previous) {
        if (previous.signature !== op.signature) throw new AppError('IDEMPOTENCY_CONFLICT', '请求标识不能用于不同操作。', 409);
        this.db.exec('COMMIT');
        return previous;
      }
      if (p.revision !== op.baseRevision) throw new AppError('REVISION_CONFLICT', '原稿已变化，请重新检查。', 409);
      this.saveOp(op);
      this.db.exec('COMMIT');
      return op;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  updateOp(op) {
    const result = this.db.prepare("UPDATE operations SET status=?,data=? WHERE id=? AND owner=? AND status IN ('queued','running')")
      .run(op.status,JSON.stringify(op),op.id,op.owner);
    return Number(result.changes) > 0;
  }

  // Commit both the derived document and operation terminal state under one lock.
  // A version-only conflict may be merged/retried; deleted, cancelled or edited
  // input must never be retried against the old model result.
  commitResult(p, op, expectedVersion) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.get(p.id, p.owner);
      const operation = this.getOp(op.id, op.owner);
      if (!['queued','running'].includes(operation.status)) throw new AppError('CANCELLED', '操作已经结束。', 409);
      if (operation.project !== p.id || current.revision !== op.baseRevision) throw new AppError('STALE_RESULT', '原稿已改变，本次结果没有覆盖新稿。', 409);
      if ((current.version ?? 0) !== expectedVersion) { this.db.exec('ROLLBACK'); return null; }
      const next = { ...p, version: expectedVersion + 1, updated: new Date().toISOString() };
      this.db.prepare('UPDATE projects SET updated=?,data=? WHERE id=? AND owner=?').run(next.updated,JSON.stringify(next),next.id,next.owner);
      this.updateOp(op);
      this.db.exec('COMMIT');
      return next;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  getOp(operation, owner) {
    const row = this.db.prepare('SELECT data FROM operations WHERE id=? AND owner=?').get(operation, owner);
    if (!row) throw new AppError('NOT_FOUND', '任务不存在或无法访问。', 404);
    const op = JSON.parse(row.data);
    const deadline=op.deadline??(Date.parse(op.created)+60000);
    if (['queued','running'].includes(op.status) && Number.isFinite(deadline) && deadline < Date.now()) {
      op.status = 'failed';
      op.error = { code:'INTERRUPTED', message:'操作已超过执行期限，请重试。已有原稿已保留。' };
      if (!this.readOnly) this.updateOp(op);
    }
    return op;
  }

  byKey(project, key, owner) {
    const row = owner===undefined?this.db.prepare('SELECT data FROM operations WHERE project=? AND key=?').get(project,key):this.db.prepare('SELECT data FROM operations WHERE project=? AND key=? AND owner=?').get(project,key,owner);
    return row ? JSON.parse(row.data) : null;
  }

  close() { this.db.close(); }

  transfer(project, from, to) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const p = this.get(project, from);
      if (this.list(to).length >= 30) throw new AppError('PROJECT_LIMIT', '账号草稿已达上限，当前匿名草稿未迁移。', 429);
      const ops = this.db.prepare('SELECT data FROM operations WHERE project=?').all(project).map(x => this.getOp(JSON.parse(x.data).id,from));
      if (ops.some(x => ['queued', 'running'].includes(x.status))) throw new AppError('BUSY', '当前草稿还有运行任务，请完成后再关联账号。', 409);
      p.owner = to;
      p.version = (p.version ?? 0) + 1;
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
