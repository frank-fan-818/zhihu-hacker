# scripts · 运维与验证脚本

这些脚本不属于应用运行时（那在 `src/`），也不属于自动测试（那在 `test/`）。
它们是**手动运行**的诊断、验证与部署工具。

全部使用相对路径，`clone` 下来即可运行，不需要改任何路径。

## 线上验证（需要代理）

本项目所在网络对 `vercel.app` 是**双重封锁**：

- **DNS 污染**：8.8.8.8 / 1.1.1.1 / 223.5.5.5 / 119.29.29.29 全都返回无关 IP
- **SNI 阻断**：即使把连接固定到正确 IP，TLS 握手仍被重置

因此访问线上站点**必须开代理**。另外 **Node 的 `fetch` 不读 `HTTPS_PROXY`**，
所以这些脚本用 undici 的 `ProxyAgent` 走 CONNECT 隧道（DNS 由代理端解析）。
undici 优先取本仓库依赖，取不到就复用 Vercel CLI 自带的副本，不额外装包。

| 脚本 | 用途 | 用法 |
|---|---|---|
| `verify-live.mjs` | **线上完整验收**：页面、API、草稿写入、初筛、知乎真实查证、回调路由 | `node scripts/verify-live.mjs [代理地址]` |
| `vercel-deploy.mjs` | 通过 Vercel API 触发生产部署并轮询到 READY | `node scripts/vercel-deploy.mjs <分支\|标签\|SHA>` |
| `vercel-set-env.mjs` | 写入生产/预览环境变量（值取自本机 `.env`，不打印密钥） | `node scripts/vercel-set-env.mjs [域名]` |

## 本地与文档检查（无需网络）

| 脚本 | 用途 | 用法 |
|---|---|---|
| `inspect-db.mjs` | 只读检视数据库：表结构、索引、行数、owner 分组、完整性 | `node scripts/inspect-db.mjs [库文件]` |
| `verify-doc-links.mjs` | 校验 `docs/` 里的相对路径引用能否解析 | `node scripts/verify-doc-links.mjs` |
| `scan-docs-secrets.mjs` | 对照本机 `.env` 扫描文档是否含真实密钥与隐私路径 | `node scripts/scan-docs-secrets.mjs` |

数据库诊断另有 `npm run db:doctor`（更完整，含迁移状态与修复提示）。

## 引用分类说明

`verify-doc-links.mjs` 把引用分三类，**只有第一类必须解析成功**：

| 类型 | 含义 |
|---|---|
| 文档相对（可点击） | 相对当前文档，点击应能打开 |
| 仓库相对（正文语境） | 相对仓库根，常见于描述"某文件在哪里" |
| 外部包内路径 | 例如官方 skill 压缩包里的 `references/*.md`，不属于本仓库 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `VERIFY_BASE` | 覆盖验收目标地址（默认 `https://zhihu-hacker.vercel.app`） |
| `VERIFY_PROXY` | 覆盖代理地址（默认 `http://127.0.0.1:7890`） |
| `SQLITE_FILE` | 覆盖数据库路径（与 `src/server.mjs` 规则一致） |

## 注意

`vercel-deploy.mjs` 与 `vercel-set-env.mjs` 读取 Vercel CLI 的凭证
（`%APPDATA%\com.vercel.cli\Data\auth.json`）与 `.vercel/project.json`，
所以需要先 `vercel login` 与 `vercel link`。走 API 而不是 CLI 上传的原因：
项目已连接 GitHub 仓库，API 触发即可，不依赖 CLI 能写 `%APPDATA%`。
