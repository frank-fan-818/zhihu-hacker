# 部署到 Vercel

本应用是原生 `node:http` 长驻服务，原本假定"单进程 + 持久磁盘"。Vercel 是无服务器
平台，因此代码里补了三处适配：请求入口（`api/index.mjs`）、数据库降级（`/tmp`）、
以及登录状态外置（`src/kv.mjs`）。**登录状态外置是必须的**：否则发起登录的实例和
接收回调的实例不是同一个，回调必然报 `OAUTH_STATE`。

## 一、部署前必须先做的两件事

### 1. 确认 URL 形态，并固定域名

Vercel 每次部署都会生成新域名（`项目名-<hash>-账号.vercel.app`）。**回调地址在知乎
平台登记后必须逐字符匹配，所以不要用每次变化的部署 URL**，要用稳定的生产域名，
或给某次部署设置固定别名。

先确定你的域名，形如：

```text
https://cognitive-debugger.vercel.app
```

### 2. 开通 Upstash Redis（登录必需）

在 Vercel 控制台 **Storage → Create Database → Upstash Redis**，创建后拿到两个值：
REST URL 和 REST Token。本应用直接调用它们的 REST 接口，**不需要安装任何 npm 依赖**。

拿到的值对应本项目的两个环境变量（名字以你要填的为准，不要照抄平台默认名）：

```text
SESSION_STORE_URL=https://xxx-xxxx.upstash.io
SESSION_STORE_TOKEN=xxxxxxxx
```

只配一个、或两个都不配时，`npm run diagnose` 会明确报出降级状态：登录仍然可用，
但只在单实例内有效，Serverless 多实例下会失败。

## 二、在知乎平台登记回调地址

在赛事项目页面 <https://www.zhihu.com/hackathon?activity_code=zhihu_hackathon_2026_p2>
的「知乎登录回调地址」处填写：

```text
https://你的域名/auth/zhihu/callback
```

对应的两个环境变量必须是（两者同源、路径固定、无尾斜杠、无查询参数）：

```text
APP_ORIGIN=https://你的域名
ZHIHU_OAUTH_REDIRECT_URI=https://你的域名/auth/zhihu/callback
```

平台登记值与 `ZHIHU_OAUTH_REDIRECT_URI` 必须完全一致。改域名意味着两处都要改。

## 三、部署

### 1. 推送到 GitHub

`cognitive-debugger` 是独立仓库（不含 `.env`、`data/`）。推到你的 GitHub 私有或公开仓库。

### 2. 在 Vercel 导入项目

- **Root Directory**：仓库根目录（即 `cognitive-debugger` 本身）
- **Framework Preset**：`Other`
- **Build Command / Output Directory**：全部留空（`vercel.json` 已声明 `framework: null`）
- **Node.js Version**：项目设置里选 **24.x**（`node:sqlite` 需要；仓库已带 `.nvmrc`）

### 3. 配置环境变量

在 Vercel 项目 **Settings → Environment Variables** 添加（Production 与 Preview 都要）：

| 变量 | 值 |
|---|---|
| `APP_ORIGIN` | `https://你的域名` |
| `ZHIHU_OAUTH_REDIRECT_URI` | `https://你的域名/auth/zhihu/callback` |
| `ZHIHU_OAUTH_APP_ID` | 你的 App ID |
| `ZHIHU_OAUTH_APP_KEY` | 你的 App Key |
| `ZHIHU_ACCESS_SECRET` | 你的 Access Secret |
| `MODEL_BASE_URL` | 例如 `https://api.deepseek.com` |
| `MODEL_NAME` | 例如 `deepseek-flash` |
| `MODEL_API_KEY` | 你的模型密钥 |
| `SESSION_STORE_URL` | Upstash REST URL |
| `SESSION_STORE_TOKEN` | Upstash REST Token |

**不要**在 Vercel 上设置 `HOST` 或 `PORT`，平台自行接管。`SQLITE_FILE` 也不用设，
部署时默认走 `/tmp/app.sqlite`。

### 4. 部署并验证

部署完成后依次确认：

1. 打开 `https://你的域名` → 页面正常加载（说明 `node:sqlite` 在 `/tmp` 起来了）。
2. 输入一段示例草稿 → 点「检查这段话」→ 出现候选问题（证明规则初筛可用）。
3. 点「查看依据」→ 返回真实知乎来源（证明 Access Secret 与网络出口可用）。
4. 点「知乎登录」→ 授权后回到 `/?login=success`，顶栏显示昵称
   （证明跨实例登录状态生效）。若回到 `/?login=failed`，多半是回调地址不一致。

## 四、必须知道的限制

| 限制 | 说明 |
|---|---|
| **草稿不持久** | SQLite 在 `/tmp`，随实例存活、冷启动即重置。草稿可能丢失且界面不会提示。这是 Vercel 无持久磁盘的必然结果，**不是配置问题**。 |
| **限流是每实例的** | 每会话 30 项目、每小时 30 次操作等计数仍在进程内（`server.mjs` 的 `questionCalls`/`answerBusy`），多实例下实际额度会放宽。不替代正式网关限流。 |
| **登录会话上限 7 天** | 会话写在 Redis，过期时间取 `min(expires_in, 7 天)`；退出登录会跨实例立即吊销。 |
| **预览域名不能当回调** | 每次部署域名都会变，登记的回调只在生产域名下匹配。 |

如果草稿持久化是评奖必需项，应改用带持久磁盘的长驻服务（Railway、Render 等），
那种形态下只需把 `APP_ORIGIN` 与 `ZHIHU_OAUTH_REDIRECT_URI` 指向平台域名，
数据库保持默认的 `data/app.sqlite` 即可，无需 `/tmp` 降级。

## 五、本地开发不受影响

不配置 `SESSION_STORE_URL` 时，登录状态走进程内存实现，`npm start` 与本地测试行为
与此前一致。本地仍监听 `127.0.0.1:4317`，数据库仍是 `data/app.sqlite`。
