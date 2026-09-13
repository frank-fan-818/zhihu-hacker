-- 002 · 重建表：外键约束 + 基础校验
--
-- 依据：PRD 第 19.4 节强制不变量 1
--   「任何跨实体 ID 都要校验所属项目和访问权限」
--   技能 schema-constraints / schema-foreign-key-indexes

-- 现状问题：
--  1. operations 没有指向 projects 的外键。删除项目靠应用层两条 DELETE 手工清理，
--     一旦中间失败就留下孤儿操作记录；也没有 ON DELETE CASCADE 可用。
--  2. revision 允许出现 0 或负数；owner 缺少非空与长度约束的显式表达；
--     data 没有 JSON 有效性校验，写坏的内容会被静默接受。
--
-- SQLite 不支持 ALTER TABLE ADD CONSTRAINT，必须重建表。
-- 这些语句由迁移运行器包在一个事务里，并在提交前做 foreign_key_check。

CREATE TABLE projects_new (
  id      TEXT PRIMARY KEY,
  owner   TEXT NOT NULL CHECK (length(owner) > 0),
  updated TEXT NOT NULL,
  data    TEXT NOT NULL CHECK (json_valid(data))
);

INSERT INTO projects_new (id, owner, updated, data)
  SELECT id, owner, updated, data FROM projects;

DROP TABLE projects;

ALTER TABLE projects_new RENAME TO projects;

-- operations 重建：加外键级联、把 type/status 提成真实列（诊断与部分索引要用）
CREATE TABLE operations_new (
  id      TEXT PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner   TEXT NOT NULL CHECK (length(owner) > 0),
  key     TEXT NOT NULL,
  type    TEXT,
  status  TEXT,
  data    TEXT NOT NULL CHECK (json_valid(data)),
  UNIQUE (project, key)
);

INSERT INTO operations_new (id, project, owner, key, type, status, data)
  SELECT id, project, owner, key,
         json_extract(data, '$.type'),
         json_extract(data, '$.status'),
         data
  FROM operations;

DROP TABLE operations;

ALTER TABLE operations_new RENAME TO operations;
