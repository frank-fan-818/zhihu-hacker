# Vercel 部署待办清单

仓库已就绪：`https://github.com/frank-fan-818/zhihu-hacker`（25 个文件，main 分支）。
完整说明见 [DEPLOY.md](DEPLOY.md)，这里只列你要手填的内容。

## 第一步：导入项目（先不填环境变量）

vercel.com → Add New → Project → 选 `zhihu-hacker` 仓库，然后按下表设置：

| 设置项 | 值 |
|---|---|
| Root Directory | 仓库根目录（不要填 `cognitive-debugger`，仓库根就是这个项目） |
| Framework Preset | `Other` |
| Build Command | 留空 |
| Output Directory | 留空 |
| Install Command | 留空（项目无依赖，不需要 npm install） |
| Node.js Version | **24.x**（项目设置里选，`node:sqlite` 依赖它） |

**环境变量一个都先不要填。** 直接 Deploy。

## 第二步：拿到域名后回填

部署完成会得到一个生产域名，形如：

```text
https://zhihu-hacker-<随机串>.vercel.app
```

把它记下来，替换下面所有的 `<域名>`。注意用**生产域名**，不要用带 hash 的预览域名。

## 第三步：环境变量清单（Settings → Environment Variables）

Production 与 Preview 两个环境都要勾选。`<域名>` 换成你的实际域名。

| 变量名 | 值 |
|---|---|
| `APP_ORIGIN` | `https://<域名>` |
| `ZHIHU_OAUTH_REDIRECT_URI` | `https://<域名>/auth/zhihu/callback` |
| `ZHIHU_OAUTH_APP_ID` | 你 `.env` 里的值 |
| `ZHIHU_OAUTH_APP_KEY` | 你 `.env` 里的值 |
| `ZHIHU_ACCESS_SECRET` | 你 `.env` 里的值 |
| `MODEL_BASE_URL` | `https://api.deepseek.com` |
| `MODEL_NAME` | `deepseek-flash` |
| `MODEL_API_KEY` | 你 `.env` 里的值 |
| `SESSION_STORE_URL` | Upstash Redis 的 REST URL（下一步拿到） |
| `SESSION_STORE_TOKEN` | Upstash Redis 的 REST Token（下一步拿到） |

**不要**填 `HOST`、`PORT`、`SQLITE_FILE`：前者平台接管，数据库在 Vercel 上强制使用共享 Redis，缺少配置将拒绝启动。

## 第四步：开 Upstash Redis

Vercel 控制台 → Storage → Create Database → Upstash Redis → 创建后连接到本项目。
它会自动注入自己的环境变量名（常见是 `KV_REST_API_URL` / `KV_REST_API_TOKEN`）。

**本项目读的是 `SESSION_STORE_URL` / `SESSION_STORE_TOKEN`**，所以要把对应值
再手动添加成这两个名字（或把 `src/kv.mjs` 里的变量名改成平台注入的名字）。

没有这一步，登录在 Vercel 上会失败：发起登录和接收回调会落在不同实例。

## 第五步：在知乎登记回调

赛事项目页面 <https://www.zhihu.com/hackathon?activity_code=zhihu_hackathon_2026_p2>
的「知乎登录回调地址」填：

```text
https://<域名>/auth/zhihu/callback
```

必须与 `ZHIHU_OAUTH_REDIRECT_URI` **逐字符相同**。

## 第六步：改完环境变量后重新部署

环境变量修改不会自动生效，需要在 Deployments 里对最新部署点 Redeploy。
之后点一次「知乎登录」实测：授权后回到 `/?login=success` 且顶栏显示昵称即为成功。

## 已知限制（务必知情）

- **持久化**：草稿、任务和登录状态在共享 Redis；上线前确认禁用 eviction 并配置备份。旧 /tmp 数据不会自动迁移，发布前应导出需要保留的旧稿。
- **限流是每实例的**：多实例下限流额度会放宽，不替代正式网关限流。
- 域名一旦登记回调就不能随便换，换域名要同时改 `APP_ORIGIN`、`ZHIHU_OAUTH_REDIRECT_URI` 和知乎登记值三处。
