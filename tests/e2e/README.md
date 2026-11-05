# 界面回归与截图

在仓库根目录用项目支持的 Node.js 版本运行：

```powershell
npm ci
npm run test:e2e:prepare
npm run test:e2e
npm run test:ui:capture
```

浏览器回归与截图使用本机 Chrome。找不到时用 `BROWSER_PATH` 指定 Chrome 的可执行文件。Puppeteer 固定在独立的测试锁文件中。两条命令在独占本机端口运行 Vite，只在测试页面内模拟 Tauri 响应。截图和度量默认位于 `artifacts/ui-review/after`。

在另一个已恢复依赖的源码副本上拍摄同场景对照时，设置这两个变量后运行截图命令：

```powershell
$env:VELLORA_UI_REVIEW_ROOT = (Resolve-Path -LiteralPath '../vellora-ui-baseline').Path
$env:VELLORA_UI_REVIEW_LABEL = 'before'
npm run test:ui:capture
Remove-Item Env:VELLORA_UI_REVIEW_ROOT, Env:VELLORA_UI_REVIEW_LABEL
```

Windows x64 原生回归需要 Rust MSVC、WebView2 Runtime、tauri-driver 2.0.6 和匹配 Runtime 的 Microsoft Edge WebDriver。下面的下载命令仅写本仓库的驱动缓存：

```powershell
cargo install tauri-driver --version 2.0.6 --locked
npm run tools:msedgedriver
$env:VELLORA_DESKTOP_SCREENSHOT_DIR = 'artifacts/ui-review/desktop'
npm run test:e2e:desktop
```

原生回归编译嵌入前端资源的测试 EXE，使用独立的应用标识、WebView2 配置和临时 Markdown 文件。测试通过真实 Tauri IPC 保存并回读磁盘字节。可用 `MSEDGEDRIVER_PATH` 指定已安装驱动，启动前会再次校验 Microsoft Authenticode 签名和 Runtime 版本。仅需预编译时运行 `npm run test:e2e:desktop -- --build-only`。
