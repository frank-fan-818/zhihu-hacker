# 数据层优化建议

对照依据：PRD 第 19 节（数据模型与一致性要求）、第 22.3 节（存储需支持事务与唯一约束）、
第 38 节（上线条件），以及 Supabase Postgres 最佳实践的 8 类规则。

结论先说：**当前的存储形态能满足 MVP 演示，但没有满足 PRD 自己的强制不变量。**
分三级列出，其中 P0 已在本轮实现并验证。

---

## 一、当前形态与 PRD 的差距

### 1.1 实体覆盖

PRD 第 19.1 节列出 **15 个核心实体**，第 19 节开头明确「数据库实现可合并表，
但不能丢失字段语义和引用约束」。

实际实现是 **2 张表**：

| 表 | 列 | 承载的内容 |
|---|---|---|
| `projects` | id / owner / updated / data(JSON) | Project、Claim、Evidence、Gap、UserDecision、Draft、TextAnchor、CheckItem、RevisionSuggestion、Citation、Source、Verification 全部塞在 `data` 里 |
| `operations` | id / project / owner / key / data(JSON) | ResearchOperation、ProviderUsage |

合并本身是 PRD 允许的。问题在于**合并的同时丢了约束**。

### 1.2 强制不变量的满足情况

| # | PRD 第 19.4 节不变量 | 现状 |
|---|---|---|
| 1 | 任何跨实体 ID 都要校验所属项目和访问权限 | **不满足**。`operations.project` 没有外键，删项目靠应用层两条 DELETE |
| 2 | 引用不能指向已删除或无权读取的私人来源 | **不满足**。Citation 只是 JSON 里的 id 数组，删除来源后无检测 |
| 3 | 被排除观点不进入新草稿，除非用户再次选择 | 由应用层保证（`suggestions` / `user_status`），无存储级防护 |
| 4 | 来源摘要和模型改写分开存储 | 满足（`s.text` 与 `s.explanation` 分列） |
| 5 | 缺口处理记录必须包含所依赖的观点版本 | **不满足**。`findings[].baseRevision` 存在但无约束，且 Gap 未独立建模 |
| 6 | 显示"已保存"之前服务端必须确认保存成功 | 满足（同步写入后才返回） |
| 7 | 公共检索缓存不得含私人草稿 | 满足（当前无公共缓存表；检索结果按项目隔离存储） |

### 1.3 具体技术缺陷

| 位置 | 问题 | 影响 |
|---|---|---|
| 两张表 | **除主键外零索引** | `WHERE owner=? ORDER BY updated DESC` 全表扫 + 排序 |
| `service.edit/apply/undo/defer` | 先读后写，revision 比较在应用层 | **检查-使用间隙**：并发请求可同时通过检查，后写覆盖先写 |
| `operations` | 无 `REFERENCES projects(id)` | 删除中断会产生孤儿记录；无 `ON DELETE CASCADE` |
| `projects.data` | 无 `json_valid` 校验 | 写坏的内容被静默接受 |
| schema 演进 | 只有 `CREATE TABLE IF NOT EXISTS` | 无法给已存在的表加约束；无法回答"现在是什么版本" |
| `list()` | `SELECT data` 取整份文档再丢弃 | 读放大；文档会随 findings/sources 增长 |
| 连接 | 无 `busy_timeout` | 并发写直接抛 `SQLITE_BUSY`，不是排队等待 |
| 连接 | 无 `foreign_keys=ON` | SQLite 默认关闭外键，即使声明了也不生效 |

---

## 二、P0：已在本轮实现

### 2.1 版本化迁移（[`../../src/migrations.mjs`](../../src/migrations.mjs) + [`../../src/migrations/`](../../src/migrations/)）

此前 schema 只靠 `CREATE TABLE IF NOT EXISTS` 隐式演进。现在是四条带版本号的迁移：

```
001-base-schema.sql         基础表（IF NOT EXISTS，兼容全新库与老库）
002-constraints.sql         重建表：外键级联 + CHECK 约束
003-indices.sql             索引
004-generated-columns.sql   生成列 + 部分索引
```

三个设计要点：

- **每条迁移记录 SHA-256 校验和**。已应用的迁移文件被改动时，启动直接报
  `MIGRATION_DRIFT` 而不是静默跑偏差 schema。要改就新增一条。
- **每条迁移独立事务**，提交前跑 `PRAGMA foreign_key_check`，有违规整体回滚。
- **重建表期间关闭外键**（SQLite 的 PRAGMA 在事务内无效，所以放在事务外开关）。

### 2.2 索引（技能规则 `query-missing-indexes`、`schema-foreign-key-indexes`）

```sql
CREATE INDEX idx_projects_owner_updated    ON projects(owner, updated DESC);
CREATE INDEX idx_operations_project        ON operations(project);
CREATE INDEX idx_operations_owner          ON operations(owner);
CREATE INDEX idx_operations_project_owner  ON operations(project, owner);
CREATE INDEX idx_operations_unfinished     ON operations(project, status)
  WHERE status IN ('queued','running');                      -- 部分索引
CREATE INDEX idx_projects_question         ON projects(owner, question_url)
  WHERE question_url IS NOT NULL;                            -- 部分索引
```

- 复合索引的列顺序必须与 `(过滤列, 排序列)` 一致才能同时消掉扫描与排序。
- 外键侧必须手动建索引：SQLite 与 Postgres 都不会自动建，而 `ON DELETE CASCADE`
  要靠它才能避免锁全表。
- 未完成操作只占少数，用部分索引而不是全列索引。

### 2.3 引用完整性与约束（`schema-constraints`）

```sql
project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
owner   TEXT NOT NULL CHECK (length(owner) > 0),
data    TEXT NOT NULL CHECK (json_valid(data))
```

SQLite 不支持 `ALTER TABLE ADD CONSTRAINT`，所以 002 走的是标准重建流程：
建新表 → 搬数据 → 删旧表 → 改名 → 重建索引。

### 2.4 乐观并发控制下推到数据库 ← **本轮最有价值的修复**

原实现：

```js
const p = store.get(project, owner);
if (p.revision !== revision) throw CONFLICT;   // 检查
p.text = text; p.revision++;
store.save(p);                                  // 使用 —— 间隙在这里
```

两个标头并发的请求可以**都**通过第 2 行，然后后者覆盖前者，一次修改静默丢失。
`autosave` 是 800ms 防抖 + 最长 5 秒一次（PRD 18.8），多标签页或手机/桌面同开就会撞上。

现在比较在写入语句里完成：

```js
UPDATE projects SET data=?, updated=?
 WHERE id=? AND owner=? AND json_extract(data,'$.revision')=?
```

`changes === 0` 表示 revision 已变化，转成 409。数据库的行锁保证比较与写入原子。

> **踩坑记录**：`revision` 被 004 提成了**虚拟生成列**，不能直接 `SET revision=?`
> （报 `cannot UPDATE generated column`）。它由 `data` 的 `$.revision` 派生，
> 所以只写 `data`，生成列自动跟随。这一点由 `revision generated column tracks the document` 测试锁定。

### 2.5 连接层硬化

```js
PRAGMA journal_mode=WAL;      // 读写并发：读者不阻塞写者
PRAGMA busy_timeout=5000;     // 写锁等待 5s 再报错，而不是立刻 SQLITE_BUSY
PRAGMA foreign_keys=ON;       // 默认关闭，必须显式开启
PRAGMA synchronous=NORMAL;    // WAL 下的常规取舍
```

### 2.6 诊断命令（`npm run db:doctor`）

```
=== 迁移 ===   4/4 已应用，历史文件漂移 0 处
=== 完整性 === integrity_check: ok   foreign_key_check: 0 条违规   孤儿记录: 0
=== 规模 ===   projects 6 行   operations 11 行
=== 索引 ===   6 个
```

---

## 三、验证结果

### 3.1 在真实库副本上验证迁移安全性

```
迁移前: projects=6  operations=11  索引数=0
迁移后: projects=6  operations=11  索引数=6  完整性=ok  外键违规=0  孤儿=0

项目 id 集合一致 ✅   操作 id 集合一致 ✅   正文内容一致 ✅

✅ 外键拒绝孤儿操作
✅ ON DELETE CASCADE 生效（1 -> 0）
✅ CHECK 拒绝非法 JSON / 空 owner
✅ 生成列 revision 可查
```

### 3.2 测试

**56 项全部通过**（domain 8 / service 15 / integration 18 / vercel 4 / 其余），
其中新增 2 项专测本次修复：

- `concurrent writers on the same revision cannot both win`
- `revision generated column tracks the document`

---

## 四、P1：建议但未做

### 4.1 列表查询不要读整份文档

`list()` 现在 `SELECT data` 取完整 JSON 再丢弃大部分。应改为生成列直取：

```sql
SELECT id, updated, revision,
       json_extract(data,'$.title') AS title
  FROM projects WHERE owner=? ORDER BY updated DESC LIMIT ?;
```

已实现为 `Store.listLight()`，但**尚未切换调用方**——因为 `title` 目前只存在 JSON 里。
建议把 `title` 也提成生成列并加索引，彻底不读大文档。

### 4.2 分页

`projects` 有 30 条上限，暂无问题；`operations` 会随使用无限增长，且 `calls[]`
记录每次提供方请求。建议：

```sql
CREATE INDEX idx_operations_project_created ON operations(project, created DESC);
SELECT ... WHERE project=? AND created < ? ORDER BY created DESC LIMIT 20;
```

用 keyset 分页而不是 `OFFSET`。

### 4.3 操作历史的保留策略

PRD 第 19.5 节要求可删除、24 小时内清理。当前 `operations` 无清理机制。
建议加一个按时间删除的维护步骤，并把 `calls[]` 的历史截断（只留最近 N 次）。

### 4.4 把 `owner` 迁移为真正的外键

现在 `owner` 是散落的字符串（匿名会话哈希 / `zhihu:<哈希>`）。PRD 的
Project 实体写的是 `owner_id/session_id`。建议建 `owners` 表并让
`projects.owner` 引用它，这样"账号 30 篇上限"可以用约束表达而不是应用层 count。

### 4.5 引用一致性检查

针对不变量 2，建议加一个可运行的检查：

```sql
-- Citation 指向的 source 必须存在于同一项目的 sources 里
SELECT p.id FROM projects p,
  json_each(json_extract(p.data,'$.citations')) c
WHERE json_extract(p.data,'$.sources') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p.data,'$.sources')) s
                   WHERE json_extract(s.value,'$.id')=json_extract(c.value,'$.sourceId'));
```

---

## 五、P2：存储后端的迁移路径

`Store` 是 7 个方法的薄封装，这是当初隔离它的价值——换后端只改一个文件。

### 5.1 持久化方案对比

| 方案 | 改动 | 说明 |
|---|---|---|
| **长驻服务 + 持久磁盘** | **几乎为零** | Railway / Render 免费层。保持 [`../../data/app.sqlite`](../../data/)（不入库），不需要 `/tmp` 降级。**当前最省事** |
| Turso（托管 SQLite） | 小 | 兼容 SQLite 方言与 `json_extract`，迁移文件可复用 |
| Neon / Supabase（Postgres） | 中大 | SQL 方言需调整（`json_extract` → `->>`，`AUTOINCREMENT` 等），`transfer()` 的事务语义要复核 |

### 5.2 若换 Postgres，这些规则仍然适用

技能里的多数规则是通用的，但有几处需要改：

| SQLite 写法 | Postgres 对应 |
|---|---|
| `json_extract(data,'$.revision')` | `(data->>'revision')::int` |
| 虚拟生成列 `GENERATED ALWAYS AS (...) VIRTUAL` | `GENERATED ALWAYS AS (...) STORED` |
| `PRAGMA foreign_keys=ON` | 默认即开启 |
| `PRAGMA busy_timeout` | 用连接池（`conn-pooling`）+ 事务超时 |
| 部分索引 `WHERE status IN (...)` | 语法相同，直接可用 |
| —— | **新增 RLS**（`security-rls-basics`）：现在靠 `WHERE owner=?` 手工过滤，Postgres 应用 RLS 策略做纵深防御 |

Postgres 下还应启用：
- `conn-pooling`：Serverless 必须用连接池（PgBouncer / Supavisor），否则每次冷启动建连接会打爆 `max_connections`
- `lock-short-transactions`：`transfer()` 用 `BEGIN IMMEDIATE` 持有写锁，在 Postgres 下应缩短事务
- `monitor-pg-stat-statements`：找出慢查询

---

## 六、优先级汇总

| 优先级 | 项目 | 状态 |
|---|---|---|
| **P0** | 版本化迁移 + 校验和 | ✅ 已实现 |
| **P0** | 6 个索引（含 2 个部分索引） | ✅ 已实现 |
| **P0** | 外键级联 + CHECK 约束 | ✅ 已实现 |
| **P0** | 乐观并发控制下推到数据库 | ✅ 已实现 |
| **P0** | 连接 PRAGMA 硬化 | ✅ 已实现 |
| **P0** | `npm run db:doctor` 诊断 | ✅ 已实现 |
| **P1** | 列表查询不读整份文档 | 已备 `listLight()`，待切调用方 |
| **P1** | 操作历史分页与保留策略 | 待做 |
| **P1** | `owners` 表替代字符串 owner | 待做 |
| **P1** | 引用一致性检查 | 待做 |
| **P2** | 换持久化后端（优先长驻服务） | 待决策 |

**优先级顺序的理由**：P0 全部是"正确性"问题——丢数据、坏数据、无法演进。
P1 是规模问题，现在数据量小还不痛。P2 是部署形态问题，取决于是否要求跨重启持久。
