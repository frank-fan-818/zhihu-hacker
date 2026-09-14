# 认知调试器 · 可运行开发版本

最新配置步骤见 [SETUP.md](SETUP.md)，部署到 Vercel 见 [DEPLOY.md](DEPLOY.md)。新增 OAuth 登录与指定草稿关联、主题问题起稿、回答摘要、手动额度诊断；接口成功链路仍待真实凭据验收。

发表前，从一处具体原句开始，查看依据、比较候选修改，再由作者决定是否采用。

## 启动

需要 Node.js 24（本次验证为 24.13.0）。使用原生 HTTP 和浏览器 JavaScript；本地 SQLite、Vercel 共享 Redis。首次启动先执行 `npm.cmd ci`。

```powershell
Set-Location 'D:\Programming Projects\知乎黑客松\cognitive-debugger'
npm.cmd start
```

打开 http://127.0.0.1:4317 。默认仅监听本机。数据库在 `data/app.sqlite`，同目录可能有 WAL 文件；备份请先停止服务。Node 24 的 SQLite 仍会打印实验性功能警告。

## 可体验的流程

1. 点击“试一段示例草稿”，或输入 20—10,000 字符的文本。
2. 点击“检查这段话”：保存草稿并定位最多一处候选问题。无模型时明确显示“本地规则初筛”，只识别部分强断言。
3. 点击“查看依据”：具备知乎凭据时才检索。没有凭据会明确报错，不生成假资料。
4. “帮我改准确”需要已获得的依据和模型；“仅调整表述”无模型时提供明确标注的断言转疑问句候选，不承诺保持句式或核对事实。
5. 对比原句与候选句，点击“采用这处修改”；只替换对应位置，保存新版本。之后可继续检查全文或安全撤销。
6. 刷新可恢复当前草稿与任务查询；支持手动保存、自动保存、复制、带逐句引用的 Markdown 下载、HTML 预览和项目删除。

## 外部服务配置

`npm start` 使用 Node 加载应用目录的 `.env`，进程环境变量优先。配置后重启服务。不要将真实密钥写进源码或提交版本库。

| 环境变量 | 用途 |
|---|---|
| `ZHIHU_ACCESS_SECRET` | 知乎开发者提供的 Access Secret，仅服务端使用 |
| `MODEL_BASE_URL` | 支持 Chat Completions 的接口基础地址，例如提供商文档中的 `/v1` 地址；服务会追加 `/chat/completions` |
| `MODEL_NAME` | 该提供商支持的模型 ID |
| `MODEL_API_KEY` | 模型服务凭据 |
| `PORT` | 默认 4317 |
| `HOST` | 默认 127.0.0.1；当前版本以本地使用为目标 |
| `APP_ORIGIN` | 可选，服务的精确来源地址；自定义域名需匹配，当前版本没有完成公网部署验收 |
| `SESSION_STORE_URL` / `SESSION_STORE_TOKEN` | 共享键值存储（Upstash Redis REST）。**Serverless 上必填**：不配置时登录状态只在单实例内有效，回调落到别的实例会报 `OAUTH_STATE`。本地可留空 |
| `SQLITE_FILE` | 可选，数据库路径。仅本地 SQLite 使用，默认 `data/app.sqlite`；Vercel 强制使用 Redis |
| `PROVIDER_RETRIES` | 可选，外部知乎/模型网络错误的有限重试次数，默认 1，最大 2；不会重试已取消请求 |

模型需支持 `response_format: json_object`；响应须为非流式 JSON。可用状态仅表示配置存在，不代表联网探活成功。

任务状态优先通过 `/api/operations/:id/events` 使用 SSE 推送，代理不支持或连接超时会自动回退到轮询。操作终态会记录完成时间和重试次数；本地启动时会尽力清理超过 7 天的终态操作记录。Vercel Redis 仍使用原子文档/操作提交，持久化任务队列（Redis Streams/BullMQ）可作为下一阶段接入。

## 知乎接口在哪里、什么时候用

来源：官方开发文档 <https://pcnsiq9mmnww.feishu.cn/wiki/Pd1UwIIBriW0DBk8qlIczBAVnJc>，以及此前核对的官方 CLI Skill `0.5.3-beta.20260904115023`。本应用直接调用 HTTP，无需安装 CLI Skill。

| 用户动作 | 调用 | 输入和结果用途 |
|---|---|---|
| 初筛、全文文本检查 | 不调用知乎 | 模型分析文本，或本地规则检查 |
| 查看某条原句的依据 | `GET https://developer.zhihu.com/api/v1/content/zhihu_search` | `Query` 为目标原句，最多 300 字符；`Count=5`，展示知乎检索摘要和来源链接 |
| 同一次查看依据 | `GET https://developer.zhihu.com/api/v1/content/global_search` | 相同 Query/Count，补充外部检索材料；最多各调用一次 |
| 再次打开已完整成功的相同版本依据 | 30 分钟内读本地结果 | 失败或部分失败允许重试；没有后台自动重试 |
| 修改建议、整理稿件 | 不额外调用知乎 | 将已取得的材料与文本交给配置的模型，校验返回来源 ID；不能自行捏造来源 URL |
| 保存、采用、复制、下载 | 不调用知乎 | 本地数据操作 |

请求携带服务端 Bearer Secret 与 `X-Request-Timestamp` 秒级时间戳。只接受真实返回的安全 HTTP(S) 来源链接，内容按摘要展示。模型分析的“支持/限制/背景”是基于摘要的解释，不是逐句事实认证。官方 Skill 是接口使用说明与调用工具封装，不是产品的认知分析引擎。

本轮没有接入热榜、授权用户回答、圈子、故事/知识详情或自动发布接口；不为展示接入数量而空调用。

## 存储、任务与保护

- 本地 SQLite / Vercel Redis 保存项目和操作。匿名 Cookie 隔离工作副本；登录可关联当前研究记录。共享 Redis 登录会话跨实例有效。清除匿名 Cookie 后没有恢复入口。
- 同一幂等键重复提交不重复执行；草稿版本变化会拒绝旧建议与迟到结果；取消或删除后不回写数据。
- 任务使用 60 秒截止时间，异常中止后查询会返回中断状态；Vercel 用 waitUntil 绑定执行生命周期。没有自动重试付费调用。诊断不会中断任务。
- 每账号/匿名身份最多 30 项目；服务端预算默认每 IP 每小时 20 次、全站每小时 200 次查询/操作请求。配置 Redis 后预算跨实例共享，可用 IP_HOURLY_LIMIT / GLOBAL_HOURLY_LIMIT 调整；这些是请求上限，不是货币额度。
- 模型配置后，检查会将草稿发送到指定模型服务；查证将目标原句发送到知乎接口；资料比较会将检索摘要发送到模型服务。
- 下载包含当前稿和“研究资料”附录；附录是检索记录，包含历史材料，不代表每项材料均支撑最终稿。当前没有逐句引用导出。
- 没有自动过期清理、跨设备同步、生产级备份、加密存储或公网运维配置。项目删除不可撤销。

## 测试与本轮边界

```powershell
npm.cmd test
npm.cmd run check
```

2026-09-13：21 项自动测试通过，包括初筛零搜索、检索去重/缓存、部分失败、凭据缺失、取消、旧版本拒绝、删除不复活、采用/撤销、持久化、会话隔离和接口参数契约。外部接口测试使用明确的 fixture transport，没有调用真实知乎或模型服务。

浏览器实际通过：示例输入 → 原句初筛 → 缺少知乎凭据提示 → 仅调整表述 → 采用 → 刷新保留 → 全文复查。检查中修复疑问句重复触发规则和手机宽度溢出；375px 内容区域的 scrollWidth 与 clientWidth 相等，控制台未见警告或错误。

这是第一条核心路径的实现，不是整份 PRD 全功能交付。真实模型和知乎成功链路尚待配置凭据后联调；问题型第二入口已实现基础流程；证据补充上传、逐句引用、可信反例卡、图谱、学习路径、分享与正式性能评估仍未实现。此版本可验证交互与数据保护，不能用于评价模型审稿质量。

## 文件导航

- `public/`：审稿台页面、交互、样式。
- `src/domain.mjs`：原句定位、规则初筛、版本替换和来源校验。
- `src/providers.mjs`：模型与官方检索适配。
- `src/service.mjs`：操作编排、取消、查证、修改与保存。
- `src/store.mjs`：SQLite 项目与操作存储；写操作走数据库层乐观并发控制。
- `src/migrations.mjs`、`src/migrations/*.sql`：版本化 schema 迁移，带校验和。
- `src/db-doctor.mjs`：`npm run db:doctor`，报告迁移状态、完整性与索引。
- `src/kv.mjs`：登录状态用的可插拔键值存储（内存 / Upstash Redis REST）。
- `src/server.mjs`：HTTP 接口、静态资源和会话边界；导出 `createRequestHandler` 供 Serverless 复用。
- `api/index.mjs`、`vercel.json`：Vercel 函数入口与路由重写。
- `test/`：行为和接口契约测试。
- `scripts/`：手动运行的诊断、验证与部署工具，详见 [scripts/README.md](scripts/README.md)。
- `docs/plans/`：产品 PRD、接入审查、数据层优化分析与实施记录。

HTTP 路由：`/api/projects` 创建/列举，`/api/projects/:id` 读取/保存/删除，`/api/projects/:id/operations` 提交类型化操作，`/api/operations/:id` 查询，`/api/operations/:id/cancel` 取消；`/apply`、`/undo`、`/defer` 位于具体项目下。

## 2026-09-13 接入增量

新增 `.env.example`、`src/config.mjs`、`src/diagnose.mjs`、`src/oauth.mjs` 与 `test/integration.test.mjs`。测试总数 30；OAuth 与问题接口使用隔离测试夹具，未冒充线上联调。浏览器已检查未配置提示、问题起稿与摘要展示，手机内容区 375px 无水平溢出。

命令：`npm run diagnose` 仅检查配置；`npm run quota` 主动查实际知乎额度。OAuth 配置、回调和待用户步骤以 SETUP.md 为准。新增 `/api/auth`、`/api/auth/start`、`/api/auth/logout`、`/auth/zhihu/callback`、`/api/questions` 和 `/api/projects/:id/answers`。

## 历史记录：2026-09-13 部署适配增量（已被下述生产修复替代）

为部署到 Vercel，新增 `src/kv.mjs`、`api/index.mjs`、`vercel.json`、`.nvmrc`、`test/vercel.test.mjs` 与 `DEPLOY.md`。登录的待处理 state、登录会话与退出代号从进程内存迁到键值存储：未配置 Redis 时用内存实现（本地行为不变），配置 `SESSION_STORE_URL`/`SESSION_STORE_TOKEN` 后走 Upstash REST 接口（无新增 npm 依赖）。数据库在 Vercel 上降级到 `/tmp/app.sqlite`。

这一步解决的是无服务器平台上的登录可靠性：改造前"发起登录"与"接收回调"落在不同实例时必定失败，现在有测试固定该行为。注意 `/tmp` 是每实例、随冷启动重置的，**草稿在 Vercel 上不持久**。

测试总数 40（domain 8 / service 13 / integration 15 / vercel 4），`node --check` 覆盖改动文件。Upstash 适配器用本地假 REST 端点验证 REST 契约、TTL、计数与命名空间，未使用真实凭据。

## 生产审计修复

见 [修复与验收记录](docs/production-remediation-2026-09-13.md)。Vercel 不再使用 /tmp SQLite，缺少共享 Redis 时拒绝启动。新接口适配使用 @vercel/functions；运行 npm ci 安装锁定依赖。测试中的 audit 文件现在断言正确行为。启用 TEST_REDIS_URL 后还会执行真实 Redis 的跨实例、原子写入和登录回归；CI 必跑该组测试。
