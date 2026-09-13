-- 004 · 生成列 + 部分索引：把热点查询从"读全部 JSON 再在 JS 里过滤"下推到数据库
--
-- 依据：技能 advanced-jsonb-indexing（把 JSON 里被查询的字段提成可索引列）
--       query-partial-indexes（只索引真正会被查的子集）
--
-- 现状：revision 只存在 data JSON 里，但它是每次写入都要比较的乐观并发控制字段；
--   findings/sources 的规模也只能把整行读进 Node 才数得出来。
--   生成列是 VIRTUAL 的，不占存储；对表达式建索引才落盘。

ALTER TABLE projects ADD COLUMN revision INTEGER
  GENERATED ALWAYS AS (json_extract(data, '$.revision')) VIRTUAL;

ALTER TABLE projects ADD COLUMN question_url TEXT
  GENERATED ALWAYS AS (json_extract(data, '$.question.url')) VIRTUAL;

-- 未完成的操作是恢复逻辑要扫的目标，通常只占少数 → 部分索引
CREATE INDEX IF NOT EXISTS idx_operations_unfinished
  ON operations(project, status)
  WHERE status IN ('queued', 'running');

-- 按问题聚合草稿（引用一致性检查、后续逐句引用导出都要它）
CREATE INDEX IF NOT EXISTS idx_projects_question
  ON projects(owner, question_url)
  WHERE question_url IS NOT NULL;
