# Vellora

Vellora 是一个本地优先的 Markdown 桌面写作与阅读工具，基于 Electron、React、TypeScript 和 Electron Vite 构建。它面向需要在本机打开 Markdown 文件、整理、搜索和轻量编辑 `.md` / `.markdown` 文件的用户。

其他语言： [English](README.en.md) | [日本語](README.ja.md) | [Русский](README.ru.md)

## 功能特性

- 打开单个 Markdown 文件，并在本地渲染标题、引用、表格、代码块、图片和链接。
- 打开文件夹，浏览 Markdown 文件树，并通过筛选快速定位文档。
- 使用文档搜索和标题大纲在长文档中跳转。
- 解析相对路径本地图片，缺失图片会显示占位提示。
- 支持 WYSIWYG 阅读编辑和源码编辑分屏，保存前会跟踪未保存状态。
- 通过受控主进程 API 打开本地 Markdown 链接，并在访问外部链接前显示安全确认。
- 支持通过系统默认编辑器打开当前文件。
- Windows 打包使用 NSIS 安装包，可选择安装路径，并可关联 .md 和 `.markdown` 文件。

## 本地开发

```bash
npm install
npm run dev
```

常用命令：

- `npm run typecheck`: 运行 TypeScript 类型检查。
- `npm test`: 运行 Vitest 单元测试和打包配置测试。
- `npm run build`: 构建 main、preload 和 renderer 输出到 `out/`。
- `npm run dist`: 构建并生成 Windows NSIS 安装包到 `release/`。
- `npm run test:e2e:stageN`: 运行指定阶段的 Playwright E2E 测试，例如 `npm run test:e2e:stage5`。

## 安全与数据

应用不会主动上传用户文档。文件读取、保存、图片解析和链接打开都通过受控的 Electron main/preload API 执行。卸载或删除应用不会删除用户文档，也不会删除用户自己的 Markdown 文件。

## 许可证

本项目使用 MIT License。完整文本见 [LICENSE](LICENSE)。
