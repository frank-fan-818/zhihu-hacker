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
2. 点击“检查这段话”：保存草稿并定位最多一处候选问题；被检查的原句会在你的原稿里高亮。无模型时明确显示“本地规则初筛”，本地规则只覆盖两类可判定线索：绝对化范围词（一定/必然/所有人…），以及范畴或单位错配（例如“意大利面拌42号混凝土”）。它不做语义理解，漏报是常态，所以没有命中时只说“这次初筛没有需要立刻处理的项”，不说“没有问题”。
3. 右侧“再看一眼”面板按“一次只做一个决定”组织：步骤条显示当前在第几步，主决策区只突出一个下一步，其余动作收进“其他选择”。点“在原稿中定位”会把光标和视口带到那一句。
4. 点“查这一句的依据”：具备知乎凭据时才检索。没有凭据会明确报错，不生成假资料。
5. 点“先不看依据，直接改”会先给出本地规则的“改前 → 改后”差异示意（标注“未核对事实”）。“用查到的材料改准确”需要已获得的依据和模型，缺依据时明确提示先查依据，不静默失败。
6. 候选句以对照 + 字符级差异展示，采用前不会改动原稿；点“采用这处修改”只替换对应位置并保存新版本。之后面板给出“这句话改好了 / 现在的说法”，并可安全撤销。
7. 刷新可恢复当前草稿与任务查询；支持手动保存、自动保存、复制、Markdown 下载和项目删除。

## 两个「从问题开始」的入口

「还没写？从一个真实问题开始」里有两个入口，最后都汇到同一个项目上下文（一条真实问题 + 一篇草稿 + 同一个审稿工作台）：

1. **主题搜索**：填「讨论主题」（2—100 字符），需要时再补一个「补充关键词」。补充词会直接拼进查询串——因为平台的推荐对措辞很敏感，实测同一个词（例如「远程办公」）反复查都返回空，加一个词就有结果，这一步不假装平台在做语义扩写，界面上会写清这次实际查的是什么。
   - 查到 0 条时不再笼统地说「换个更具体的主题」：接口返回 `{items, emptyReason, query}`，有平台给的原因就照实显示，没有就说明「平台这次没有召回」，并提示主题本身可能太宽或太窄。查询失败（未配置凭据、额度受限）仍是非 2xx 的具体错误，不会被说成「没查到」。
   - 点某条问题的标题去知乎看原讨论；点「围绕这题写」把它变成你的草稿并关联到当前项目。
2. **粘贴链接**：把知乎问题页地址粘进来即可，标题可以不填。`questionLink()` 把常见的复制形态归一成同一个地址——带 `utm_*` 等追踪参数、带锚点、落在 `/answer/123` 回答页、`m.zhihu.com` 手机域名、`http`、以及裸问题编号都接受；非知乎域名、个人主页、群链接等一律拒绝并给出可操作的提示，不做「猜一个数字」的兜底。
   - 只贴链接还没动笔时，界面会按问题标题起一段草稿再建项目（服务端要求草稿 20—10,000 字符），而不是送空文本。
   - 关联后问题标题会显示在「02 再看一眼」上方，并出现「看看其他回答」。没有标题时显示为「知乎问题 <编号>」，仍然可点开。

「看看其他回答」的摘要来自 `question_answers`，**只放在正文下面供对照，不进入证据面板、不改动正文**：`sources` 仍只由「查这一句的依据」写入。这条边界在接口层和界面上都写着。

## 审稿意见的判定标准

“什么样的意见算中肯”有明文标准，不在提示词里散落：[docs/review-standard.md](docs/review-standard.md)。
要点：先点明这句话主张了什么（事实类要出处、价值判断只要求自洽、偏好不报），再按五类缺口报（范畴错配／因果缺失或倒置／以偏概全／数量或事实无出处／与常识或共识冲突），每条带严重度与一个修改方向，宁可少报。含空话的理由会被服务端拒绝，不会显示给作者。
标准实现在 `src/review-prompt.mjs`，契约由 `test/review-prompt.test.mjs` 固定，真实模型质量由 `npm run verify:prompt` 验收。

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
| `IP_HOURLY_LIMIT` / `GLOBAL_HOURLY_LIMIT` | 可选，请求级预算上限（默认 20 / 200） |
| `QUESTION_HOURLY_LIMIT` | 可选，每身份每小时的「找相关问题 + 看其他回答」次数上限，默认 20；超出返回 `QUESTION_LIMIT`，界面会引导改用粘贴链接 |
| `SQLITE_FILE` | 可选，数据库路径。仅本地 SQLite 使用，默认 `data/app.sqlite`；Vercel 强制使用 Redis |

模型需支持 `response_format: json_object`；响应须为非流式 JSON。可用状态仅表示配置存在，不代表联网探活成功。

## 知乎接口在哪里、什么时候用

来源：官方开发文档 <https://pcnsiq9mmnww.feishu.cn/wiki/Pd1UwIIBriW0DBk8qlIczBAVnJc>，以及此前核对的官方 CLI Skill `0.5.3-beta.20260904115023`。本应用直接调用 HTTP，无需安装 CLI Skill。

| 用户动作 | 调用 | 输入和结果用途 |
|---|---|---|
| 初筛、全文文本检查 | 不调用知乎 | 配置了模型就由模型分析文本；否则或模型本次调用失败时，用本地规则检查，并在结果里写明这次是谁看的稿 |
| 输入主题找相关问题 | `GET https://developer.zhihu.com/api/v1/user/question_recommendations` | `Query`=主题（可含补充关键词，服务端截到 100 字符）、`Count=5`，返回问题标题与链接；空结果把平台的 `EmptyReason` 一起交给界面 |
| 粘贴问题链接 | 不调用知乎 | 本地解析并归一化链接（`questionLink()`），只认知乎域名；标题可选，缺省时界面显示问题编号 |
| 查看某条原句的依据 | `GET https://developer.zhihu.com/api/v1/content/zhihu_search` | `Query` 为目标原句，最多 300 字符；`Count=5`，展示知乎检索摘要和来源链接 |
| 同一次查看依据 | `GET https://developer.zhihu.com/api/v1/content/global_search` | 相同 Query/Count，补充外部检索材料；最多各调用一次 |
| 看看其他回答 | `GET https://developer.zhihu.com/api/v1/content/question_answers` | `QuestionUrl` + `Offset`/`Limit=10`，按 `Paging.NextOffset` 翻页；摘要只作对照，不进证据面板 |
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
- 模型配置后，检查会将草稿发送到指定模型服务；查证将目标原句发送到知乎接口；资料比较会将检索摘要发送到模型服务。模型调用失败（密钥失效、欠费、网关故障）不会让检查整体失败，而是退回本地规则，并在 `lastCheck.note` 与面板上写明原因——不会显示成“没有问题”。
- 下载包含当前稿和“研究资料”附录；附录是检索记录，包含历史材料，不代表每项材料均支撑最终稿。当前没有逐句引用导出。
- 没有自动过期清理、跨设备同步、生产级备份、加密存储或公网运维配置。项目删除不可撤销。

## 测试与本轮边界

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run check:ui
# 配好模型凭据后，用同一批样例验收检查提示词：
npm.cmd run verify:prompt
# 用真实知乎数据压测取数／判定／证据管道（结果与报告在 data/reliability/，该目录不进版本库）：
node --env-file-if-exists=.env scripts/reliability-battery.mjs
node scripts/reliability-report.mjs
```

`scripts/check-ui.mjs`（`npm run check:ui`）是不依赖浏览器的界面完整性检查：`app.js` 引用的 id 是否都存在于 `index.html`、是否给运行期才生成的按钮做了加载时绑定、CSS 变量是否都有定义、以及源码编码是否完好（U+FFFD / 控制符 / 常用字占比）。它挡的是沙箱里无法用真实浏览器验收的那一类确定性错误。

`npm test` 用 Node 自带 runner 的默认隔离（每个测试文件一个子进程）。在禁止创建子进程的受限沙箱里它会以 `spawn EPERM` 全量失败——那说明 runner 起不来，不代表用例挂了。这种情况用同一条命令的单进程模式：

```powershell
npm.cmd run test:serial
```

2026-09-13：21 项自动测试通过，包括初筛零搜索、检索去重/缓存、部分失败、凭据缺失、取消、旧版本拒绝、删除不复活、采用/撤销、持久化、会话隔离和接口参数契约。外部接口测试使用明确的 fixture transport，没有调用真实知乎或模型服务。

2026-09-14：全量 123 项测试中 114 项通过、9 项跳过（真实 Redis 组需 `TEST_REDIS_URL`，另一项在禁止创建子进程的环境里只做无子进程的那一半断言并写明原因）。新增覆盖：问题链接的各种复制形态归一化、非问题链接被拒、空召回保留 `EmptyReason`、`/api/questions` 区分空召回与调用失败、`/api/questions/link` 归一化契约、「只贴链接、还没动笔」这条路径能建出可检查的草稿、以及主题搜索额度耗尽时返回 `QUESTION_LIMIT` 并提示改用链接入口。

同一轮用真实凭据做了端到端验收（本地服务 + 开放平台只读接口，29 项断言全通过）：主题搜索空召回如实归因、带追踪参数/回答页/手机域名/裸编号的链接都归一成 `https://www.zhihu.com/question/368830073`、无标题关联可查其他回答（10 条摘要）、关联后改写正文不丢问题上下文、摘要不进入 `sources`。

限额有两层，界面据此给不同出路：请求级预算默认每 IP 每小时 20 次（`RATE_LIMIT`），主题搜索/回答分页另有每身份每小时 20 次（`QUESTION_LIMIT`，可用 `QUESTION_HOURLY_LIMIT` 调整）。**没有真实浏览器验收**：本次只做了接口级端到端验收与 `npm run check:ui` 静态检查，浏览器环境（Chrome 扩展通道）在这台机器上不可用，375px 溢出与视觉一致性仍需人工在浏览器里确认。

浏览器实际通过：示例输入 → 原句初筛 → 缺少知乎凭据提示 → 仅调整表述 → 采用 → 刷新保留 → 全文复查。检查中修复疑问句重复触发规则和手机宽度溢出；375px 内容区域的 scrollWidth 与 clientWidth 相等，控制台未见警告或错误。

这是第一条核心路径的实现，不是整份 PRD 全功能交付。真实模型和知乎成功链路尚待配置凭据后联调；问题型第二入口已实现基础流程；证据补充上传、逐句引用、可信反例卡、图谱、学习路径、分享与正式性能评估仍未实现。此版本可验证交互与数据保护，不能用于评价模型审稿质量。

## 文件导航

- `public/`：审稿台页面、交互、样式。
- `src/domain.mjs`：原句定位、规则初筛（强断言 + 范畴/单位错配）、版本替换、来源校验，以及问题链接的归一化（`questionLink()`：移动端域名、追踪参数、回答页后缀、裸编号）。
- `src/review-prompt.mjs`：审稿意见的判定标准与检查、复核提示词（标准正文见 docs/review-standard.md）。
- `src/providers.mjs`：模型与官方检索适配。
- `src/service.mjs`：操作编排、取消、查证、修改与保存。
- `src/store.mjs`：SQLite 项目与操作存储；写操作走数据库层乐观并发控制。
- `src/migrations.mjs`、`src/migrations/*.sql`：版本化 schema 迁移，带校验和。
- `src/db-doctor.mjs`：`npm run db:doctor`，报告迁移状态、完整性与索引。
- `src/kv.mjs`：登录状态用的可插拔键值存储（内存 / Upstash Redis REST）。
- `src/server.mjs`：HTTP 接口、静态资源和会话边界；导出 `createRequestHandler` 供 Serverless 复用。
- `api/index.mjs`、`vercel.json`：Vercel 函数入口与路由重写。
- `test/`：行为和接口契约测试。检查质量的回归样例在 `test/fixtures/`：`check-samples.json` 由本地规则单测消费，`prompt-samples.json` 由模型验收脚本消费。
- `scripts/`：手动运行的诊断、验证与部署工具，详见 [scripts/README.md](scripts/README.md)；`check.mjs` 做语法检查，`check-ui.mjs` 做界面与前端逻辑的一致性检查（id、事件绑定、CSS 变量、编码）。
- `docs/plans/`：产品 PRD、接入审查、数据层优化分析与实施记录。

HTTP 路由：`/api/projects` 创建/列举，`/api/projects/:id` 读取/保存/删除，`/api/projects/:id/operations` 提交类型化操作，`/api/operations/:id` 查询，`/api/operations/:id/cancel` 取消；`/apply`、`/undo`、`/defer` 位于具体项目下；`/api/questions` 按主题找问题（返回 `{items, emptyReason, query}`），`/api/questions/link` 归一化粘贴的问题链接，`/api/projects/:id/answers` 取回答摘要。

## 2026-09-13 接入增量

新增 `.env.example`、`src/config.mjs`、`src/diagnose.mjs`、`src/oauth.mjs` 与 `test/integration.test.mjs`。测试总数 30；OAuth 与问题接口使用隔离测试夹具，未冒充线上联调。浏览器已检查未配置提示、问题起稿与摘要展示，手机内容区 375px 无水平溢出。

命令：`npm run diagnose` 仅检查配置；`npm run quota` 主动查实际知乎额度。OAuth 配置、回调和待用户步骤以 SETUP.md 为准。新增 `/api/auth`、`/api/auth/start`、`/api/auth/logout`、`/auth/zhihu/callback`、`/api/questions` 和 `/api/projects/:id/answers`。

## 历史记录：2026-09-13 部署适配增量（已被下述生产修复替代）

为部署到 Vercel，新增 `src/kv.mjs`、`api/index.mjs`、`vercel.json`、`.nvmrc`、`test/vercel.test.mjs` 与 `DEPLOY.md`。登录的待处理 state、登录会话与退出代号从进程内存迁到键值存储：未配置 Redis 时用内存实现（本地行为不变），配置 `SESSION_STORE_URL`/`SESSION_STORE_TOKEN` 后走 Upstash REST 接口（无新增 npm 依赖）。数据库在 Vercel 上降级到 `/tmp/app.sqlite`。

这一步解决的是无服务器平台上的登录可靠性：改造前"发起登录"与"接收回调"落在不同实例时必定失败，现在有测试固定该行为。注意 `/tmp` 是每实例、随冷启动重置的，**草稿在 Vercel 上不持久**。

测试总数 40（domain 8 / service 13 / integration 15 / vercel 4），`node --check` 覆盖改动文件。Upstash 适配器用本地假 REST 端点验证 REST 契约、TTL、计数与命名空间，未使用真实凭据。

## 生产审计修复

见 [修复与验收记录](docs/production-remediation-2026-09-13.md)。Vercel 不再使用 /tmp SQLite，缺少共享 Redis 时拒绝启动。新接口适配使用 @vercel/functions；运行 npm ci 安装锁定依赖。测试中的 audit 文件现在断言正确行为。启用 TEST_REDIS_URL 后还会执行真实 Redis 的跨实例、原子写入和登录回归；CI 必跑该组测试。
