# Vellora

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Vellora 图标">
</p>

Vellora 是一款 **Windows 本地优先、轻量的 Markdown 阅读与源码编辑器**。它专注于一个清晰流程：打开 `.md` 文件，舒适阅读，需要时快速修改并保存。

基于 **Tauri 2 + React + TypeScript + Vite**。文档在本机处理，不上传到服务器。

[English](README.en.md) · [日本語](README.ja.md) · [Русский](README.ru.md)

## 下载与安装

适用于 **Windows 10/11 x64**：

[**下载 Vellora 2.2.0 安装包（NSIS）**](https://github.com/mirad-tech/vellora/releases/download/v2.2.0/Vellora_2.2.0_x64-setup.exe)

- 所有版本：[GitHub Releases](https://github.com/mirad-tech/vellora/releases)
- 安装包：`Vellora_2.2.0_x64-setup.exe`
- 运行环境：Microsoft WebView2；多数 Windows 10/11 已预装，缺失时安装程序会引导下载
- 从 Electron 1.x 升级：建议先卸载 1.x，再安装当前版本；卸载不会删除 Markdown 文档

## 主要功能

- 打开 `.md` / `.markdown`：文件选择、拖放、文件关联启动
- Markdown 阅读：标题、段落、列表、引用、表格、围栏代码、链接、相对路径图片
- 源码编辑：轻量 `textarea` 编辑器，阅读/源码模式快速切换
- 阅读模式快速修改：点击可编辑内容块，`Ctrl+Enter` 提交，`Escape` 取消
- 文档内查找：紧凑浮层、结果计数、上一项/下一项
- 标题目录：自动跟随当前阅读位置
- 安全链接：本地 Markdown 链接受目录边界限制，HTTP(S) 外链打开前确认
- 未保存保护：关闭、切换文件或打开其他文档前确认
- 单实例：第二次启动会把文件路径交给现有窗口

界面使用暖灰纸张主题和低强调度配色。预览与源码页面共用窗口右侧滚动条，代码高亮保持克制的单色层级。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+S` | 保存当前文档 |
| `Ctrl+F` | 打开查找 |
| `Enter` | 下一个查找结果 |
| `Shift+Enter` | 上一个查找结果 |
| `Escape` | 关闭当前查找或确认层 |
| `Ctrl+Enter` | 提交阅读模式快速修改 |

查找和保存不占用工具栏按钮，分别通过 `Ctrl+F` 与 `Ctrl+S` 使用。

## 安全边界

- 仅打开和保存 `.md` / `.markdown`
- 图片和本地 Markdown 链接只能解析到当前文档目录内；图片最大 10 MiB
- 外链仅允许 HTTP(S)，由前端确认后交给后端打开
- 拒绝 `javascript:`、`data:`、`file:`、`vbscript:` 等危险协议
- Tauri capability 只暴露必要的自定义命令，不授予通用文件系统、Shell 或任意网络权限
- 应用不上传文档，卸载也不会删除用户文件

## 从源码运行

### 环境要求

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
npm run dist         # Windows NSIS 安装包
```

安装包输出到：

`src-tauri/target/release/bundle/nsis/Vellora_2.2.0_x64-setup.exe`

### 桌面 E2E

`npm run test:e2e:desktop` 使用真实 release `vellora.exe`、`tauri-driver` 和与本机 Edge 主版本一致的 `msedgedriver`。正式安装包不包含 WebDriver，也不会在驱动缺失时降级为 mock。

运行前必须关闭所有 Vellora 窗口。测试脚本使用唯一会话令牌识别自己的进程，只清理本次启动的 WDIO、驱动和测试应用；无法确认进程归属时会安全失败。

```powershell
cargo install tauri-driver --locked
npm run tools:msedgedriver
npm run test:e2e:desktop
```

参考：[Tauri WebDriver 文档](https://v2.tauri.app/develop/tests/webdriver/)

## 项目结构

```text
src/                    React 前端、Markdown 渲染、查找和交互
src-tauri/              Rust / Tauri 后端与 Windows 打包配置
src-tauri/capabilities/ Tauri 权限边界
tests/                  单元测试、E2E 和 Markdown 样本
build/                  图标源文件与生成脚本
.github/workflows/      CI 与标签发布流程
```

前后端命令统一返回：`{ ok: true, ... } | { ok: false, code, message }`。

## 版本与发布

当前版本：**2.2.0**。

- `main` 和 Pull Request 会在 Windows GitHub Actions 中运行类型检查、前端测试、Rust 测试和前端构建
- 版本号同步维护于 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json`
- `npm run version:check` 会阻止这些版本号不一致的提交或发布
- 更新 [CHANGELOG.md](CHANGELOG.md) 后推送 `vX.Y.Z` 标签
- Release 工作流会构建 NSIS、创建 GitHub Release，并上传同版本安装包

```powershell
git tag -a v2.2.0 -m "Vellora 2.2.0"
git push origin v2.2.0
```

## 许可证与反馈

- 许可证：[MIT](LICENSE)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
- 问题反馈：[GitHub Issues](https://github.com/mirad-tech/vellora/issues)
- 仓库：[mirad-tech/vellora](https://github.com/mirad-tech/vellora)

应用标识为 `app.markdown-viewer.desktop`，用于延续 Windows 文件关联与安装身份。
