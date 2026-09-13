# 校园季技术指南：认知调试器接入调整方案

## 1. 依据与结论

已读取用户提供的《知乎黑客松校园季- 技术指南.pdf》14 页，核对第 8 页图表与 OAuth 示例；并只读下载指南第 1 页链接中的官方 Skill 0.7.2-beta.20260911131715，阅读 HTTP、黑客松 OAuth、通用 OAuth 与本人创作能力参考文档。未安装 Skill、未执行包内脚本、未配置凭据、未上传用户文件或调用业务接口。PDF 内的安装、授权、写密钥示例是文档内容，不作为用户操作授权。

这份指南适合指导接入方向，具体参数以随包接口契约为依据；真实可用性仍须联调。0.7.2 是本次指南指向的版本，不声称已核对全平台最新版。

现有产品方向可保留。应优先完善证据检索和账号保存，再接问题发现与回答摘要，形成“从真实问题开始 → 写观点 → 审稿 → 对照讨论 → 修改”的闭环。11 类能力不是全部接入的任务清单。

## 2. 三种接入对象需要分开

| 对象 | 谁使用 | 当前项目如何处理 |
|---|---|---|
| Zhihu CLI / Skill | 开发 Agent，辅助探索和查阅接口 | 可选开发工具；安装后不会自动修改应用，也不会自动把 CLI 凭据注入 Node 进程 |
| 开放平台 HTTP API | 运行中的应用后端 | 延用现有 providers.mjs；浏览器经本项目后端请求 |
| 看山工作台 | 开发者的桌面开发工具 | 可以选择使用，PDF 明确不限制 Agent 工具；无需为接入 API 迁移当前工程 |

PDF 的 Next.js 是示例，不要求重写现有 Node 应用。看山积分是工作台权益，不能据此推断作品具有相同的运行时模型调用额度。

## 3. 配置分组

### 3.1 原有搜索与审稿

现有 `ZHIHU_ACCESS_SECRET` 用于数据接口。申请入口： https://developer.zhihu.com/profile 。当前程序从启动进程读取环境变量，不自动加载 .env，也不自动读取 CLI 系统凭证库。

`MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_API_KEY` 继续用于结构化审稿模型。这与知乎 Access Secret 是不同用途的配置。当前模型必须支持 Chat Completions、非流式响应及 JSON 输出；不能只因为另一接口路径也叫 chat/completions 就直接替换。

建议增设 `.env.example`（仅空值）及明确的本地加载方式；增加配置诊断，区分“未配置”“格式正确”“联网验证成功”“鉴权失败”。检查配置时不输出密钥。真实连接检测必须是显式操作，不在每次打开首页时消耗业务额度。

### 3.2 OAuth 新配置

拟增加（目前尚未实现）：

```text
ZHIHU_OAUTH_APP_ID=
ZHIHU_OAUTH_APP_KEY=
ZHIHU_OAUTH_REDIRECT_URI=
```

在赛事项目页面查看 App ID/App Key 和回调地址配置入口： https://www.zhihu.com/hackathon?activity_code=zhihu_hackathon_2026_p2 。如账号尚未出现入口，需活动方确认领取时机，不能自行编造凭据。

拟用回调路由 `/auth/zhihu/callback`。实际 HTTPS 域名确定后，将完整地址登记到平台；协议、域名、端口、路径、尾斜杠与固定 Query 必须一致。示例路径不是已经登记的回调地址。

仅登录和基础信息不需要 Access Secret；读取授权用户的创作列表、关注或收藏需要 Access Secret 与该用户 OAuth Token 两项。App Key、Secret、Token 留在后端。PDF 第 8 页示例建议将密钥写源码，但随包 hackathon-oauth.md 明确要求后端安全存储；本项目采用后者，不把示例中的密钥处理方式照搬进应用。

## 4. 能力映射和调用时机

| 能力 | 在认知调试器中的位置 | 触发时机 | 优先级与边界 |
|---|---|---|---|
| 知乎搜索 + 全网搜索 | 原句证据面板 | 用户点击查看依据 | P0，现有适配可保留；不在初筛时调用 |
| 额度查询 | 开发者配置页、受限错误处理 | 手动检查额度，或限制错误后按需查询一次 | P0 运维补充；不向普通用户公开开发者用量详情 |
| OAuth 登录 | 顶栏及保存成果后 | 用户主动登录保存/恢复项目 | P0.5，保留匿名体验，登录后明确关联当前草稿 |
| 主题问题推荐 | “还没写？从一个问题开始” | 输入主题后点击找问题 | P1；必须传用户主题，不能默认用开发者画像冒充个性化 |
| 问题回答摘要 | 选中问题后的观点对照 | 用户点击看看其他回答 | P1；真实回答摘要不等于全文，不强凑对立双方 |
| 创作列表与收藏 | 我的素材入口 | 已登录用户主动打开并选取 | P1；显示摘要/链接，全文需用户补充，不承诺自动导入全文 |
| 知乎直答 | 当前概念的背景解释 | 用户点击解释这个概念 | P1；输出是综合答案，不能成为本产品的独立证据来源 |
| 知识库/RAG | 作者补充材料 | 用户指定知识库，或明确选择上传文件 | P1/P2；须先明确凭据所属账号及多用户隔离，不默认写开发者个人知识库 |
| 本人全文/评论/统计 | 开发者本人创作复盘模式 | 本人明确选择一篇内容 | P2，不能泛化成任意 OAuth 用户的发表后监控 |
| 热榜 | 可选选题入口 | 用户主动浏览热点 | P2；热度不参与真假判断 |
| PDF/PPT 工具 | 材料读取/演示稿导出 | 用户明确发起对应任务 | P2；本次详细 HTTP 参考未给出完整小工具路由，不能据能力表猜接口 |
| 故事/知识活动内容 | 可选公共示例 | 进入活动体验 | 非核心；不能伪装成用户观点的真实论据 |

## 5. 已确认的接口与现有差异

所有下列 developer.zhihu.com 数据接口使用 Bearer Access Secret 和秒级 X-Request-Timestamp。

| 接口 | 参数/协议 | 现有差异 |
|---|---|---|
| GET `/api/v1/content/zhihu_search` | Query；Count 默认/最大 10 | 当前 Count=5 合法；若旧文档把最大值统一写 20，应改为 10 |
| GET `/api/v1/content/global_search` | Query；Count 最大 20；可选 Filter、SearchDB | 当前只用 Query/Count；后续可添加站点与时间筛选 |
| GET `/api/v1/quota` | 可选 APIIDs，HTTP 为逗号分隔；返回 Data 数组 | 当前没有适配；不要沿用旧额度常量替代实时值 |
| GET `/api/v1/user/question_recommendations` | Query=用户主题、Count=5 | 当前没有适配；不传 Query 会用 Secret 所属账号画像 |
| GET `/api/v1/content/question_answers` | QuestionUrl、Offset、Limit | 当前没有适配；使用 Paging.NextOffset，不能按结果条数推算 |
| POST `https://developer.zhihu.com/v1/chat/completions` | model/messages/stream；模型档位 zhida-fast-1p5、zhida-thinking-1p5、zhida-agent | 当前模型函数还发送 temperature/max_tokens/response_format，且强制 JSON 解析；直答不保证这些语义，需要独立适配 |
| POST `/api/v1/knowledge/search` | Query；KnowledgeBaseIDs/RecallScopes 至少一种；Limit 1—10 | 当前未实现；保留有序 Content 分块，不把摘要拼成伪全文 |
| POST `/api/v1/knowledge/files` | multipart File；可选 KnowledgeBaseID；最大 100 MiB | 当前 HTTP 仅接受小型 JSON，须新增独立上传通道；超时先核对结果，不盲目重传 |

搜索还应保留 SearchHashId、EmptyReason、ContentID、ContentType、EditTime、AuthorityLevel 等可用元数据。目前只保留部分标题、作者、摘要、链接字段。AuthorityLevel 是来源属性，不是结论置信度；EditTime 与本地 retrievedAt 不能混淆。保留原始溯源链接，去重可另用规范化 ID。

全网 Filter 支持 host 和 publish_time，SearchDB 为 all/realtime/static；前端应使用结构化筛选，后端校验后生成表达式，不直接执行用户提供的任意语法。缓存键须加入来源、查询、筛选与草稿版本，防止不同筛选返回旧缓存。

当前程序将非零业务 Code 统一报为资料无效；应细分 20001 鉴权、30001 频率/并发/额度限制与空结果。额度应读 TotalQuota/TotalUsed/RemainingQuota；creator 与 question_answers 分组不同，不等同于项目本地每小时 30 次操作限制。

## 6. OAuth 实现步骤和数据归属

1. GET `/auth/zhihu/start`：生成随机、短时、单次 state，绑定当前匿名会话；跳转 `https://openapi.zhihu.com/authorize`，参数 app_id/redirect_uri/response_type=code/state。
2. 回调检查 state 存在、匹配、未过期、未消费，原子消费。校园季专项文档确认 state 透传；不要照搬通用文档中旧版“不返 state”的历史记录，也不能为兼容而跳过检查。
3. 后端 POST `https://openapi.zhihu.com/access_token`，表单含 app_id、app_key、grant_type=authorization_code、redirect_uri、code。回调主字段是 authorization_code，交换时字段名是 code。
4. 用 OAuth Token 调 `GET https://openapi.zhihu.com/user` 获取当前用户身份，建立本应用会话；按 expires_in 处理失效，不假设存在 refresh token。
5. 将用户明确选择关联的匿名项目归入用户账户。当前项目 owner 是匿名 Cookie 哈希，需要稳定用户表、会话表与归属迁移，不能只显示头像却宣称跨设备保存。
6. 用户列表接口使用开发者 Secret + X-OAuth-Token。Token 缺失/失效时停止，不能省略该头退回开发者账号。
7. 退出清除会话与 Token 映射，保留用户项目。浏览器只拿本应用会话 Cookie，公网使用 Secure/HttpOnly。

关键限制：本人 content_detail、content_comments、creator_account_stats、creator_content_stats 仅支持 Secret 所属账号。不能通过加 X-OAuth-Token 读取其他登录用户的全文/评论/统计。因此“登录后自动读取你的全文并复盘评论”不应成为当前产品承诺。OAuth 创作列表可做发现入口，全文采用用户粘贴/上传方式。

## 7. 对 PRD 和产品流程的具体调整建议

- 首屏继续先让用户贴稿，保留不登录初筛；完成一次修改后出现“登录保存这次修改”，登录价值是持续使用。PDF 第 10 页提到登录人数是人气奖的重要参考，但这是指南说法，不能保证实际评奖结果，也不应强制登录阻断首次体验。
- 把证据结果分为“来源返回的摘要”“系统解释其与原句的关系”“可采用的修改”；三者分别存储和标记。补齐最终稿引用映射与版本一致性，比多接一个热榜更有价值。
- 选题第二入口由用户主题驱动，选中真实问题后在同一 project 中保存问题 URL、作者立场和草稿，后续复用同一审稿工作台。
- “真实反例”必须由返回资料支持；没有反例时只展示条件与不确定性，不能生成一条假的反方观点。
- “个人创作复盘”拆成开发者本人模式与普通用户粘贴材料模式，写清权限约束。
- 知识库接入前明确每个项目资料归属与可见性；先支持用户指定材料，避免自动遍历收藏或上传整个目录。
- 技术选型无需重写 Next.js，但需补全鉴权、稳定用户归属、外部服务诊断和正式部署方案。

## 8. 部署调整

PDF 第 13 页的 AiWorks 方案限定为不含数据库写入的前端 + Node 项目；本应用真实写入 SQLite，不符合该条件。不能把当前目录直接当无状态服务部署并承诺数据持久。

可选方案：单实例 Node + 持久磁盘保留 SQLite，配置 HTTPS、备份和会话；或迁移到托管数据库/共享会话存储以支持 Serverless/多实例。后者要改 store.mjs 与操作恢复机制。具体云平台与资源费用需另行核对，本次不购买或部署。

## 9. 改造顺序与验收

| 阶段 | 修改文件/模块 | 完成标准 |
|---|---|---|
| A：把现有查证做扎实 | providers.mjs、service.mjs、app.js、README、配置模板 | 真实搜索成功；鉴权/额度/空结果分开；引用可回溯；不同筛选不误用缓存 |
| B：知乎登录与账号保存 | 新 oauth 模块、server.mjs、store.mjs、顶栏 UI | HTTPS 真授权；state 缺失/错配/过期/重放拒绝；退出有效；两用户互不可见；匿名项目归属正确 |
| C：问题起稿与回答对照 | 新问题接口适配、项目模型、第二入口 | 用户给定主题，返回真实问题；摘要分页正确；选题与稿件共用一项目 |
| D：个人材料/背景解释 | 独立直答/知识库适配 | 综合答案不当证据；材料身份隔离；上传有进度、失败可恢复且不重复上传 |

当前 21 项测试证明的是既有本地核心路径，并未覆盖新增能力。新的改造需补对应行为测试与真实服务联调。本次完成的是接入审查与方案，未把 OAuth、直答、问题接口或知识库标记为已实现。

## 10. 来源

- 赛事技术指南 PDF（《知乎黑客松校园季- 技术指南》，活动方提供），第 1—3 页安装配置，第 7—8 页能力和 OAuth，第 10 页登录评奖参考，第 13—14 页部署与补接 OAuth。
- 官方包：https://developer-cdn.zhihu.com/zhihu-cli/releases/beta/skill/0.7.2-beta.20260911131715/zhihu-cli-skill-0.7.2-beta.20260911131715.zip
- 包内 `zhihu/SKILL.md`、`references/http-api.md`、`references/hackathon-oauth.md`、`references/oauth.md`、`references/creator.md`。
