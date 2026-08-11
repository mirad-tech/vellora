# Vellora

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Vellora 图标">
</p>

Vellora 是一款面向 **Windows 与 macOS、本地优先、轻量的 Markdown 阅读与源码编辑器**。它专注于一个清晰流程：打开 `.md` 文件，舒适阅读，需要时快速修改并保存。

基于 **Tauri 2 + React + TypeScript + Vite**。文档在本机处理，不上传到服务器。

[English](README.en.md) · [日本語](README.ja.md) · [Русский](README.ru.md)

## 下载与安装

| 平台 | 支持状态 | 获取方式 |
|---|---|---|
| Windows 10/11 x64 | 当前公开版本为 2.2.4 | 下载 NSIS 安装包 |
| macOS 12+（Apple Silicon / Intel） | Universal 应用与 DMG 已通过双架构 CI；2.2.4 暂无正式 macOS 资产 | 按 macOS 说明构建 ad-hoc 测试包 |

### Windows 10/11 x64

[**下载 Vellora 2.2.4 安装包（NSIS）**](https://github.com/mirad-tech/vellora/releases/download/v2.2.4/Vellora_2.2.4_x64-setup.exe)

- 所有版本：[GitHub Releases](https://github.com/mirad-tech/vellora/releases)
- 安装包：`Vellora_2.2.4_x64-setup.exe`
- 运行环境：Microsoft WebView2；多数 Windows 10/11 已预装，缺失时安装程序会引导下载
- 从 Electron 1.x 升级：建议先卸载 1.x，再安装当前版本；卸载不会删除 Markdown 文档

### macOS 12+

当前源码继续支持同时包含 `arm64` 与 `x86_64` 的 Universal 应用和 DMG。本次 2.2.4 Release 仅提供 Windows NSIS 安装包，暂不发布签名 DMG；可按 [macOS 构建与验证说明](mac/README.md) 在 Mac 或 GitHub Actions 中生成 ad-hoc 测试包。

## 主要功能

- 打开 `.md` / `.markdown`：文件选择、拖放、文件关联启动
- Markdown 阅读：标题、段落、列表、引用、表格、围栏代码、链接、相对路径图片
- 源码编辑：轻量 `textarea` 编辑器，阅读/源码模式快速切换
- 阅读模式快速修改：点击可编辑内容块，`Ctrl+Enter` / `⌘Enter` 提交，`Escape` 取消
- 文档内查找：预览模式高亮匹配，源码模式选中并滚动到当前匹配，支持结果计数与上一项/下一项
- 标题目录：自动跟随当前阅读位置
- 安全链接：本地 Markdown 链接受目录边界限制，HTTP(S) 外链打开前确认
- 未保存保护：关闭、切换文件或打开其他文档前确认
- 单实例：第二次启动会把文件路径交给现有窗口

界面使用暖灰纸张主题和低强调度配色。预览与源码页面共用窗口右侧滚动条，代码高亮保持克制的单色层级。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+S` / `⌘S` | 保存当前文档 |
| `Ctrl+F` / `⌘F` | 打开查找 |
| `Enter` | 下一个查找结果 |
| `Shift+Enter` | 上一个查找结果 |
| `Escape` | 关闭当前查找或确认层 |
| `Ctrl+Enter` / `⌘Enter` | 提交阅读模式快速修改 |

查找和保存不占用工具栏按钮，Windows 使用 `Ctrl`，macOS 使用 `⌘`。

## 安全边界

- 仅打开和保存 `.md` / `.markdown`
- 图片和本地 Markdown 链接只能解析到当前文档目录内；图片最大 10 MiB
- 外链仅允许 HTTP(S)，由前端确认后交给后端打开
- 拒绝 `javascript:`、`data:`、`file:`、`vbscript:` 等危险协议
- Tauri capability 只暴露必要的自定义命令，不授予通用文件系统、Shell 或任意网络权限
- 应用不上传文档，卸载也不会删除用户文件

## 从源码运行

### Windows 环境要求

- Windows 10/11
- Node.js 20.19+、22.12+ 或更高版本
- [Rust MSVC 工具链](https://rustup.rs/)
- Visual Studio C++ Build Tools
- Microsoft WebView2 Runtime

```powershell
npm install
npm run dev          # Tauri 桌面开发模式
npm run dev:web      # 仅运行前端
```

### 验证与构建

```powershell
npm run typecheck    # TypeScript 类型检查
npm test             # 前端单元测试
npm run test:rust    # Rust 单元测试
npm run test:e2e     # 浏览器 E2E，mock Tauri IPC
npm run build:web    # 前端生产构建
npm run dist         # Windows NSIS 安装包，并整理本地发布产物
```

`npm run build` 的原始安装包输出到：

`src-tauri/target/release/bundle/nsis/Vellora_2.2.4_x64-setup.exe`

`npm run dist` 还会把当前版本复制到：

`artifacts/releases/current/Vellora_2.2.4_x64-setup.exe`

`artifacts/releases/` 是不提交到 Git 的本地发布库：`current/` 只保留当前版本，`manifest.json` 记录文件大小与 SHA-256；正式历史版本由 GitHub Releases 保留。
可运行 `npm run release:prune-old` 删除遗留本地安装器，或运行
`npm run release:check` 检查当前安装包与清单。详细规则见 [本地发布产物管理](docs/releases/local-artifacts.md)。

### 桌面 E2E

`npm run test:e2e:desktop` 使用真实 release `vellora.exe`、`tauri-driver` 和与本机 Edge 主版本一致的 `msedgedriver`。正式安装包不包含 WebDriver，也不会在驱动缺失时降级为 mock。

运行前必须关闭所有 Vellora 窗口。测试脚本使用唯一会话令牌识别自己的进程，只清理本次启动的 WDIO、驱动和测试应用；无法确认进程归属时会安全失败。

```powershell
cargo install tauri-driver --locked
npm run tools:msedgedriver
npm run test:e2e:desktop
```

参考：[Tauri WebDriver 文档](https://v2.tauri.app/develop/tests/webdriver/)

### macOS 开发与构建

macOS 需要 Node.js 22、Rust stable 与 Xcode Command Line Tools。Universal 构建还需 `aarch64-apple-darwin`、`x86_64-apple-darwin` 两个 Rust target：

```bash
npm ci
npm run dev:mac
npm run test:e2e:mac
npm run dist:mac
```

具体的 ad-hoc/正式签名模式、产物位置和实机验收要求见 [mac/README.md](mac/README.md)。

## 项目结构

```text
src/                    React 前端、Markdown 渲染、查找和交互
src-tauri/              共享 Rust / Tauri 后端与安全权限
mac/                    macOS 配置、构建脚本、E2E 和说明
src-tauri/capabilities/ Tauri 权限边界
tests/                  单元测试、E2E 和 Markdown 样本
assets/icons/           应用图标源文件
tools/                  图标、版本、发布和 WebDriver 维护工具
docs/                   仓库结构与发布产物文档
.github/workflows/      CI 与标签发布流程
```

完整目录边界见 [仓库目录说明](docs/repository-layout.md)。

前后端命令统一返回：`{ ok: true, ... } | { ok: false, code, message }`。

## 版本与发布

当前版本：**2.2.4**。

- `main` 和 Pull Request 会在 Windows、Apple Silicon 与 Intel GitHub Actions 中运行版本检查、类型检查、前端/Rust 测试、浏览器 E2E 和构建
- macOS CI 还会运行真实桌面 E2E、构建 Universal DMG，并在 Intel runner 上复核 Apple Silicon runner 生成的同一份产物
- 版本号同步维护于 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json`
- `npm run version:check` 会阻止这些版本号不一致的提交或发布
- 更新 [CHANGELOG.md](CHANGELOG.md) 后推送 `vX.Y.Z` 标签
- Release 工作流会构建 NSIS、创建 GitHub Release，并上传同版本安装包

```powershell
git tag -a v2.2.4 -m "Vellora 2.2.4"
git push origin v2.2.4
```

## 许可证与反馈

- 许可证：[MIT](LICENSE)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 安全策略：[SECURITY.md](SECURITY.md)
- 问题反馈：[GitHub Issues](https://github.com/mirad-tech/vellora/issues)
- 仓库：[mirad-tech/vellora](https://github.com/mirad-tech/vellora)

应用标识为 `app.markdown-viewer.desktop`，用于延续 Windows 文件关联与安装身份。
