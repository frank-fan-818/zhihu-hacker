-- 003 · 索引
--
-- 依据：技能 query-missing-indexes / schema-foreign-key-indexes
--   「Queries filtering or joining on unindexed columns cause full table scans」
--   「Postgres does not automatically index foreign key columns」（SQLite 同理）
--
-- 现状：两张表除主键外没有任何索引，但查询实际按 owner / updated / project 过滤。
--   projects.list          : WHERE owner=? ORDER BY updated DESC  → 全表扫 + 排序
--   operations.getOp/byKey : WHERE id=? / project=?+key=?         → 全表扫
--   operations.delete      : WHERE project=? AND owner=?          → 全表扫

-- 覆盖 list 的过滤与排序：复合索引顺序必须与 (过滤列, 排序列) 一致
CREATE INDEX IF NOT EXISTS idx_projects_owner_updated
  ON projects(owner, updated DESC);

-- 外键侧索引：删除项目时级联删操作记录要靠它，否则锁全表
CREATE INDEX IF NOT EXISTS idx_operations_project
  ON operations(project);

CREATE INDEX IF NOT EXISTS idx_operations_owner
  ON operations(owner);

CREATE INDEX IF NOT EXISTS idx_operations_project_owner
  ON operations(project, owner);
