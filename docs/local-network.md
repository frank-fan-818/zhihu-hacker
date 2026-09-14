# 本机网络：为什么 Node 连不上外网，以及怎么让它走代理（2026-09-14）

## 现象

- `developer.zhihu.com`（开放平台）从 Node 直连 **可以** 通。
- `zhihu-hacker.vercel.app`（线上部署）、`api.ipify.org` 从 Node 直连 **不通**：分别是 `UND_ERR_CONNECT_TIMEOUT` 和 `ECONNRESET`。
- 我之前把这条写成「外网 DNS 不通」，**那是错的**，见下面的实测。

## 实测结论（逐层定位）

| 检查 | 结果 |
|---|---|
| DNS 解析 `zhihu-hacker.vercel.app` | 正常，解析到 `45.114.11.238` |
| DNS 解析 `api.ipify.org` | 正常，`104.26.12.205` |
| DNS 解析 `developer.zhihu.com` | 正常（返回 IPv6 地址） |
| 进程内 `HTTP_PROXY` / `HTTPS_PROXY` | **未设置** |
| WinINET 系统代理（注册表 `Internet Settings`） | `ProxyEnable=1`，`ProxyServer=127.0.0.1:7890` |
| `127.0.0.1:7890` 是否在监听 | **在**（本机代理进程活着） |
| 其他常见端口 7897 / 10809 / 10808 / 1080 / 8080 | 均未监听 |

**根因**：域名解析没问题，出站 TCP 走不通。本机开着代理（`127.0.0.1:7890`），但那个设置只写在 **Windows 系统代理设置（WinINET）** 里——只有 WinINET/Chromium 这类应用会读它。Node 的内建 `fetch`（undici）**不会**读系统代理，它只认环境变量。于是 Node 直连被丢到了一条走不通的出站路径上，表现成超时/重置；只有本来就能直连的域名（开放平台）照常工作。

## 让 Node 走代理

Node 24 支持 `NODE_USE_ENV_PROXY=1`，打开后内建 `fetch` 会读 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`：

```powershell
$env:HTTP_PROXY  = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
# 本来就能直连的域名留在直连里，避免白白绕一圈（也避免代理侧对这些域名的解析差异）
$env:NO_PROXY    = 'localhost,127.0.0.1,developer.zhihu.com,www.zhihu.com,openapi.zhihu.com'
$env:NODE_USE_ENV_PROXY = '1'

node .\tmp\proxy-check.mjs      # 验证：IP 回显、线上首页都应 200
```

实测通过：`api.ipify.org` 200（出口 IP `103.151.173.204`）、`zhihu-hacker.vercel.app` 首页 200、`developer.zhihu.com` 仍 200。

## 两个坑

1. **`curl.exe` 在这个沙箱里不能用来判断网络**：它以 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` 失败，是受控环境拿不到安全凭证，与网络本身无关。用 Node 自己的 `fetch` 测。
2. **代理端口会变**：本次是 7890（Clash 默认）。如果哪天又不通，先确认代理进程在监听哪个端口，再改上面两个变量；`tmp/network-diagnose.mjs` 会逐个探测常见端口。

## 顺带发现

本轮改动（可选补充关键词、粘贴问题链接入口、空召回 `emptyReason`、`QUESTION_LIMIT` 出路）**都还没有部署**：线上 `zhihu-hacker.vercel.app` 返回的首页里没有 `#topic-keyword` / `#question-link` / `#use-question-link` 等元素，`/app.js` 里也没有 `localQuestionLink`、`questionScaffold`、`emptyReason`、`QUESTION_LIMIT`、`retry-topic` 任何一处。线上 `/api/status` 显示 `storage: redis`、`model: false`。需要在本地提交后重新部署，线上才会看到这两条入口。
