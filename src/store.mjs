import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './domain.mjs';

export class Store {
  constructor(file) {
    if(file !== ':memory:') mkdirSync(dirname(file), {recursive:true});
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, updated TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project,key));`);
    for(const row of this.db.prepare('SELECT data FROM operations').all()) {
      const op = JSON.parse(row.data);
      if(['queued','running'].includes(op.status)) {
        op.status='failed'; op.error={code:'INTERRUPTED',message:'服务已重启，上次任务中断。已有资料已保留。'};
        this.saveOp(op);
      }
    }
  }
  get(project, owner) {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=? AND owner=?').get(project,owner);
    if(!row) throw new AppError('NOT_FOUND','项目不存在或无法访问。',404);
    return JSON.parse(row.data);
  }
  save(p) {
    p.updated = new Date().toISOString();
    this.db.prepare('INSERT INTO projects VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data').run(p.id,p.owner,p.updated,JSON.stringify(p));
    return p;
  }
  list(owner) {
    return this.db.prepare('SELECT data FROM projects WHERE owner=? ORDER BY updated DESC LIMIT 30').all(owner).map(r => {
      const p = JSON.parse(r.data); return {id:p.id,title:p.title,updated:p.updated};
    });
  }
  delete(project,owner) {
    this.get(project,owner);
    this.db.prepare('DELETE FROM projects WHERE id=? AND owner=?').run(project,owner);
    this.db.prepare('DELETE FROM operations WHERE project=? AND owner=?').run(project,owner);
  }
  saveOp(op) {
    this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(op.id,op.project,op.owner,op.key,JSON.stringify(op));
  }
  getOp(operation,owner) {
    const row=this.db.prepare('SELECT data FROM operations WHERE id=? AND owner=?').get(operation,owner);
    if(!row) throw new AppError('NOT_FOUND','任务不存在或无法访问。',404);
    return JSON.parse(row.data);
  }
  byKey(project,key) {
    const row=this.db.prepare('SELECT data FROM operations WHERE project=? AND key=?').get(project,key);
    return row ? JSON.parse(row.data) : null;
  }
  close(){this.db.close();}
  transfer(project,from,to){
    const p=this.get(project,from);
    if(this.list(to).length>=30)throw new AppError('PROJECT_LIMIT','账号草稿已达上限，当前匿名草稿未迁移。',429);
    const ops=this.db.prepare('SELECT data FROM operations WHERE project=?').all(project).map(x=>JSON.parse(x.data));
    if(ops.some(x=>['queued','running'].includes(x.status)))throw new AppError('BUSY','当前草稿还有运行任务，请完成后再关联账号。',409);
    this.db.exec('BEGIN IMMEDIATE');
    try{p.owner=to;this.db.prepare('UPDATE projects SET owner=?,data=? WHERE id=? AND owner=?').run(to,JSON.stringify(p),project,from);
      for(const op of ops){op.owner=to;this.db.prepare('UPDATE operations SET owner=?,data=? WHERE id=?').run(to,JSON.stringify(op),op.id);}
      this.db.exec('COMMIT');return p;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
}
