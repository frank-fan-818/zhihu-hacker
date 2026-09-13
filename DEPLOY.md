# Vercel 部署与数据保护

应用使用 Node.js 24；`api/index.mjs` 统一处理请求，`@vercel/functions` 的 `waitUntil` 维持异步任务。草稿、研究记录、任务和登录状态使用共享 Upstash Redis，**不再使用 `/tmp` SQLite**。缺少 Redis 配置时拒绝启动。

## 部署配置

1. Vercel 导入仓库，Framework 选择 Other，Root Directory 为仓库根目录，Node 选择 24.x。安装命令使用 `npm ci`，无需构建静态产物。
2. 连接 Upstash Redis。支持 `SESSION_STORE_URL` / `SESSION_STORE_TOKEN`，或平台注入的 `KV_REST_API_URL` / `KV_REST_API_TOKEN`；需要读写权限和 EVAL 支持。
3. 在 Redis 管理设置中保持 **eviction 关闭**，并按服务计划配置备份。文档键不设置 TTL，因此数据库不能采用淘汰缓存策略；容量耗尽时应拒绝写入。Redis 持久化不代替备份恢复演练。
4. 设置稳定域名 `APP_ORIGIN=https://你的域名`，知乎后台登记 `https://你的域名/auth/zhihu/callback`，对应 `ZHIHU_OAUTH_REDIRECT_URI` 必须相同。www 请求会 308 跳转到规范域名。
5. 填写 `ZHIHU_OAUTH_APP_ID`、`ZHIHU_OAUTH_APP_KEY`、`ZHIHU_ACCESS_SECRET`；模型使用 `MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_API_KEY`。
6. Production 与 Preview 使用不同 Redis 或不同 `SESSION_STORE_PREFIX`，例如 `cd:production:` / `cd:preview:`，避免预览修改正式草稿。前缀发布后不可随意更换，否则原数据将暂时不可见。

不要在 Vercel 设置 HOST、PORT、SQLITE_FILE。`vercel.json` 将函数最大时长设为 120 秒；业务任务截止时间为 60 秒，超时不回写数据。waitUntil 延长单次执行生命周期，不是持久任务队列；崩溃后查询返回中断状态，由用户重新发起，不会自动重试付费调用。

## 预算

- `IP_HOURLY_LIMIT` 默认 20：每 IP 每小时查询/操作请求数。
- `GLOBAL_HOURLY_LIMIT` 默认 200：同一命名空间的全站每小时查询/操作请求数。
- 同时限制每 owner 每小时 30 次；创建项目和发起登录有独立写入预算。
- Redis 原子计数让跨实例和替换 cookie 无法重置 IP/全局预算。Vercel 仅信任平台提供的 `x-vercel-forwarded-for`，本地使用 socket 地址。
- 这是请求预算，不是金额上限；一次查证可能调用两个检索接口与一次模型。服务商后台仍应设费用上限。达到容量/预算时明确失败，保留当前输入。

## 升级与旧数据

升级不会删除本地 `data/app.sqlite`。本地仍默认 SQLite；仅设置 `PROJECT_STORE=redis` 时才切换本地项目存储，OAuth 的 Redis 配置不会隐式切换本地项目库。

旧 Vercel `/tmp` 草稿无法通过新实例自动取回。**部署前导出需要保留的旧草稿**；若有完整 SQLite 备份，应单独规划迁移与核对 owner/操作记录，不能把未知用户归属的草稿批量关联到当前账号。本次代码修复不运行生产数据迁移。

## 验收

```powershell
npm.cmd ci
npm.cmd run check
# 指向专用测试 Redis；测试只使用随机 namespace，不清空数据库
$env:TEST_REDIS_URL='redis://127.0.0.1:6398'
npm.cmd test
```

CI 启动独立 Redis 服务并强制运行真实 Lua 测试。未设置 TEST_REDIS_URL 的本地测试会明确跳过真实 Redis 场景。

上线验收需确认：同一账号跨实例/重新登录可读取草稿；匿名修改后检查引用新原句；采用修改期间输入不丢失；state 重放被拒绝；退出阻止迟到登录；取消/删除拒绝迟到结果；服务不可用时不显示假保存成功。

`npm run db:doctor` 在本地使用只读 SQLite 连接；Vercel/PROJECT_STORE=redis 时只读检查 Redis 可达性及任务索引规模，不中断运行任务。

## 官方契约

- [Vercel waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)
- [Vercel 最大执行时间](https://vercel.com/docs/functions/configuring-functions/duration)
- [Upstash 淘汰策略](https://upstash.com/docs/redis/features/eviction)
- [Upstash EVAL 键隔离](https://upstash.com/docs/redis/features/key-locking)
