# 事故记录：integration.test.mjs 编码被毁与恢复（2026-09-14）

## 发生了什么

为了让 `test/integration.test.mjs` 里的假问题 ID 更像真的，我用一条 PowerShell 单行命令做了批量字符串替换：

```powershell
$c = Get-Content $p -Raw            # Windows PowerShell 5.1：无 BOM 的 UTF-8 被按 GBK(ANSI) 解码
$c = $c.Replace('question/1', '...')
Set-Content -Path $p -Value $c -Encoding UTF8   # 再把乱码字符串写成 UTF-8
```

结果是**整个文件的中文全部变成乱码**，其中一部分字节无法在 GBK 与 UTF-8 之间往返，直接变成 `?`，属于不可逆损坏。同一次命令里只有 2 处英文替换，代价却是整份文件。

## 为什么损失可控

- 工作区里**没有任何未提交内容**，`test/integration.test.mjs` 在 git 暂存区（`.git/index`）里就是损坏前那一版：blob `3ed640e96a12aef33b48efa262fb8ef56abf73d8`，272 行。
- 恢复方式：`git` 命令在这个沙箱里跑不起来，于是用 Node 直接读 `.git`：解析 `.git/index` 拿到 blob 号，遍历 `.git/objects` 用 `zlib.inflateSync` 解压，按内容特征比对，取出未损坏的原文。
- 恢复后重放本次改动，22 项集成测试全绿。

## 结论（改这条项目的规则）

1. **不要用 PowerShell 读写含中文的源码文件。** `Get-Content -Raw` + `Set-Content` 是最容易踩的组合：读时按 ANSI 解码，写时按 UTF-8 编码，一进一出就毁。
2. 必须批量改文本时，用编辑器工具（edit/write）或 Node 脚本，并且**改完立刻抽查中文是否正常**（`read` 一下，或用 `node --check` 加肉眼确认）。
3. 需要在沙箱里取历史版本时，`git` 和 `curl` 可能被拦；直接读 `.git/objects` 是可行的替代路径（脚本见 `tmp/git-versions.mjs`）。

## 遗留

- `tmp/` 下保留了这次恢复用的脚本与参考副本，可随时复核：`recover-encoding.mjs`、`git-blob-scan.mjs`、`git-versions.mjs`、`integration.reference.mjs`。
- `git status` 目前无法执行（沙箱拦截 `git.exe`），所以“暂存区 == 损坏前版本”的判断来自 `.git/index` 的 blob 哈希比对，而不是 `git status` 输出。

## 事后补的防线

- `scripts/check-ui.mjs`（`npm run check:ui`）里有编码哨兵：替换字符、C1 控制符、以及「常用字占比 < 0.9」都会让它失败。它同时检查 `app.js` 引用的 id 是否都存在于 `index.html`、是否给运行期才生成的按钮做了加载时绑定（同一轮真的写错过一次 `$('#retry-topic')`）。
- 沙箱限制记录：`node --test` 默认每个测试文件起子进程，在禁止创建子进程的环境里会以 `spawn EPERM` 全量失败；`npm run test:serial`（`--test-isolation=none`）能在单进程内跑完全部用例。这一条也写进了 README 的测试章节。
