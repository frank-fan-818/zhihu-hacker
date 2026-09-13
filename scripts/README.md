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

## 注意事项

`vercel-deploy.mjs` 与 `vercel-set-env.mjs` 读取 Vercel CLI 的凭证
（`%APPDATA%\com.vercel.cli\Data\auth.json`）与 `.vercel/project.json`，
所以需要先 `vercel login` 与 `vercel link`。走 API 而不是 CLI 上传的原因：
项目已连接 GitHub 仓库，API 触发即可，不依赖 CLI 能写 `%APPDATA%`。

## 已踩过的坑（记录以免重犯）

1. **PowerShell 的 `Invoke-WebRequest` 默认不按 UTF-8 发送正文**。用它测中文草稿会被存成
   问号，从而误判"初筛无发现"。测本应用一律用 Node 或 `verify-live.mjs`。
2. **PowerShell 的 `$Matches` 在未匹配时会保留上一次的值**，会让"密钥扫描通过"变成假象——
   曾出现脚本报通过但实际根本没执行检查。校验逻辑一律用 Node 写，并在 `-match` 后立刻
   取布尔结果，不要在 `ForEach-Object` 里依赖 `$Matches`。
3. **调用外部命令（`git`、`gh`、`npm`）时用管道捕获输出**在某些受限环境会被拒绝
   （`cannot create standard input pipe` / `EPERM`）。需要读输出时，让外部命令直接写文件
   再读，而不是用 `|`。
4. **命令替换 `$var = git rev-parse HEAD` 可能返回空**。要拿外部命令的结果，写文件再读更可靠。
5. **备份 SQLite 必须连 WAL 一起复制**。曾观察到 `app.sqlite` 只有 4KB 而
   `app.sqlite-wal` 有 366KB——只拷主库文件会得到空数据。三个文件
   （`.sqlite`／`-wal`／`-shm`）一起复制，或先让服务正常关闭触发 checkpoint。
6. **虚拟生成列不能直接 UPDATE**：`projects.revision` 由 `data` 的 `$.revision` 派生，
   写 `SET revision=?` 会报 `cannot UPDATE generated column`，只写 `data` 即可。
7. **`vercel.json` 的 `rewrites` 只接受 `source` + `destination`**，不接受旧的
   `handle: "filesystem"`。也不需要它：rewrites 默认就先查文件系统，
   一条 catch-all 既能静态服务 `public/`，又能把其余转发给函数。
