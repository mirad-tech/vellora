# Vellora

本地优先的轻量 Markdown 查看 / 源码编辑器。**2.0** 起基于 **Tauri 2 + React + TypeScript + Vite**，面向「打开一个 `.md` 文件后快速阅读、编辑并保存」。

[English](README.en.md) · [日本語](README.ja.md) · [Русский](README.ru.md)

## 功能

- 打开 `.md` / `.markdown`（文件选择、拖放、文件关联启动）
- 阅读渲染：标题、列表、引用、表格、围栏代码、链接、相对路径图片
- 代码高亮：bash、CSS、JavaScript、JSON、Markdown、TypeScript、HTML/XML
- 源码编辑（纯 `textarea`）与阅读模式切换；`Ctrl+S` 保存
- 未保存关闭 / 切换文件前确认
- 文档内搜索（`Ctrl+F`）与可折叠标题目录
- 相对路径本地 Markdown 链接；HTTP(S) 外链二次确认后打开
- Windows 单实例：第二次启动会把路径交给已有窗口
- NSIS 安装包；WebView2 使用系统 bootstrapper（不内嵌运行时）

## 2.0 变更摘要

相对 1.x（Electron）**保留**核心阅读/编辑/安全能力，**移除**工作区文件树、最近项目、WYSIWYG（MDXEditor）、命令面板、PDF 导出、主题/多语言、复杂原生菜单等。

安装建议：**先卸载 1.x，再安装 2.0**（干净迁移，不自动改写旧安装）。

| 指标（约） | 1.x Electron | 2.0 Tauri |
|-----------|--------------|-----------|
| 安装包    | ~100+ MiB    | ~1.5 MiB  |
| 主程序    | ~200+ MiB    | ~数 MiB   |

## 安装

### 预构建（Windows）

从 [GitHub Releases](https://github.com/mirad-tech/markdown-viewer/releases) 下载 `Vellora_2.0.0_x64-setup.exe`（或 `Vellora Setup 2.0.0.exe`），运行安装即可。

系统需可用 **WebView2**（多数 Windows 10/11 已自带；否则安装程序会引导下载）。

### 从源码构建

**前置条件（Windows）**

- Node.js 20+
- [Rust MSVC 工具链](https://rustup.rs/)
- Visual Studio C++ Build Tools
- WebView2 Runtime

```bash
npm install
npm run dev          # 开发
npm run typecheck
npm test             # 前端单测
npm run test:rust    # Rust 单测
npm run test:e2e     # 浏览器 E2E（本机 Edge + puppeteer-core）
npm run dist         # 类型检查 + 前端构建 + NSIS 安装包
```

安装包默认输出：

`src-tauri/target/release/bundle/nsis/Vellora_2.0.0_x64-setup.exe`

## 安全模型

- 仅允许打开/保存 `.md` / `.markdown`
- 图片与本地 Markdown 链接只解析为**当前文档目录内**的相对路径；图片 ≤ 10 MiB
- 外链仅 HTTP(S)，前端确认后再由后端打开；拒绝 `javascript:`、`data:`、`file:`、`vbscript:` 等
- Tauri capability 只暴露自定义命令，不授予通用文件系统 / Shell / 任意网络权限
- 应用不上传用户文档；卸载不会删除用户自己的 Markdown 文件

## 架构概要

```
src/                 React 前端（Vite）
src-tauri/           Rust / Tauri 后端（文件、图片、链接、单实例、关闭保护）
tests/e2e/           E2E（浏览器 mock IPC；可选桌面 WDIO 配置）
tests/fixtures/      Markdown 样本
```

后端命令（Result：`{ ok: true, ... } | { ok: false, code, message }`）：

`choose_markdown_file` · `open_markdown_file` · `save_markdown_file` · `resolve_local_image` · `inspect_markdown_link` · `open_external_url` · `get_initial_document` · `set_unsaved_changes` · `confirm_close`

## 版本与许可证

- 当前版本：**2.0.0**
- 应用标识：`app.markdown-viewer.desktop`
- 许可证：[MIT](LICENSE)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)

## 贡献与问题

- Issues：<https://github.com/mirad-tech/markdown-viewer/issues>
