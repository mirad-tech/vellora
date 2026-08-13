# Vellora for macOS

`mac/` 是 Vellora 的 macOS 覆盖层。界面、Markdown 渲染、文件读写与安全策略继续复用根目录的 `src/` 和 `src-tauri/`，这里不维护第二套业务源码。

## 支持范围

- macOS 12 Monterey 及以上
- Universal 应用：Apple Silicon (`arm64`) 与 Intel (`x86_64`)
- 本机与 CI 可生成 Universal `.dmg` 验证包，不启用 Mac App Store 沙盒或额外 entitlement
- Finder 双击/“打开方式”、拖放、单实例、保存和未保存保护
- 原生窗口语义：红色关闭按钮隐藏窗口，Dock 点击重新显示，`⌘Q` 退出

## 本机准备

需要 Node.js 22.13+（22.x）或 24+、Rust stable、Xcode Command Line Tools，并安装两个 Rust 目标：

```bash
xcode-select --install
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
```

构建脚本只检查依赖，不会自动安装或修改 Rust/Xcode 工具链。

## 命令

```bash
npm run dev:mac
npm run test:e2e:mac
npm run build:mac
npm run dist:mac
npm run release:check:mac
```

`dist:mac` 生成并验证：

```text
artifacts/releases/macos/<version>/Vellora_<version>_universal.dmg
artifacts/releases/macos/<version>/SHA256SUMS.txt
```

验证包含双架构、代码签名、Bundle ID、macOS 12 最低版本、Markdown 文件关联、ICNS、DMG Applications 链接与 SHA-256。

## CI 验证

`.github/workflows/ci.yml` 分别使用 Apple Silicon `macos-15` 与 Intel `macos-15-intel` runner：

- 两种架构都运行前端/Rust 测试、浏览器 E2E 和真实 Tauri 桌面 E2E
- Apple Silicon runner 构建、检查并上传一份 Universal 应用和 DMG
- 独立 Intel job 下载同一份 DMG，并再次执行 `release:check:mac`

这些 DMG 是 ad-hoc CI 验证产物，不作为正式 GitHub Release 资产。结果证明当前源码能在两种 Mac 架构上构建并运行核心自动化流程，但 runner 使用 macOS 15，不能替代 macOS 12 的启动 smoke 或 Finder、Dock、原生窗口交互等实机验收。

## 签名模式

没有 Apple 凭据时使用 `signingIdentity: "-"` 生成 ad-hoc 测试包。此类包适合本机/CI 验证，但 Gatekeeper 仍会显示未验证提示，不得作为正式公开版本。

当前标签 Release 仅发布 Windows NSIS，不使用 macOS 签名与公证凭据。若未来恢复公开签名 DMG，需要配置以下 GitHub Actions secrets：

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_API_ISSUER`
- `APPLE_API_KEY`
- `APPLE_API_KEY_P8`

未来的正式 macOS 发布流程还必须导入 Developer ID Application 证书，并通过 App Store Connect API key 完成公证和 stapling；任一凭据缺失都应停止 macOS 资产发布。

参考：[Tauri macOS 签名](https://v2.tauri.app/distribute/sign/macos/)、[Tauri DMG](https://v2.tauri.app/distribute/dmg/)、[Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)。

## 实机验收

在至少一台 Apple Silicon Mac 上检查 Finder 冷/热打开、中文与空格路径、拖放、快速修改、源码保存、红灯隐藏、Dock 恢复和 `⌘Q` 的取消/放弃流程。要宣称 macOS 12 已实测，还必须在 macOS 12 实机或虚拟机完成启动与核心流程 smoke；仅设置部署目标不等于实机验证。
