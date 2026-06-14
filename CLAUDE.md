# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

一个本地优先的 Markdown 桌面查看器，使用 Electron + React + TypeScript + Electron Vite 构建。支持打开 `.md`/`.markdown` 文件、文件夹工作区、WYSIWYG 阅读编辑/源码编辑分屏、PDF 导出、图片解析、文档搜索、大纲导航。

## 常用命令

- `npm run dev` — 启动 Electron Vite 开发模式
- `npm run typecheck` — TypeScript 类型检查 (`tsc --noEmit`)
- `npm run build` — 类型检查 + 构建到 `out/`（main / preload / renderer）
- `npm run dist` — 构建并打包 Windows NSIS 安装包到 `release/`
- `npm test` — 运行 Vitest 单元测试（src 下所有 + packaging 测试）
- `npm run test:stage1` 到 `test:stage8` — 按阶段运行单元测试，逐步累加
- `npm run test:e2e:stage1` 到 `test:e2e:stage8` — 运行单个 Playwright E2E 阶段测试
- `npm run preview` — 预览已构建的 app

## 进程架构

这是 Electron 三进程模型，进程间通过限定 IPC 信道通信：

- **Main process (`src/main/`，Node.js 环境)** — 所有文件系统访问、对话框、菜单、PDF 导出、安全策略、最近记录持久化都在主进程。`index.ts` 创建 BrowserWindow 并注册 IPC handler。
- **Preload (`src/preload/`，受限 Node.js 环境)** — `contextBridge.exposeInMainWorld` 将 `window.mdViewer` API 暴露给渲染进程。每个 API 方法封装一个 `ipcRenderer.invoke` 调用。preload 构建为 CJS 格式。
- **Renderer (`src/renderer/`，纯浏览器沙箱环境)** — React 19 单页应用，通过 `window.mdViewer` 调用所有主进程能力。主组件 `App.tsx` 包含所有 UI 状态和逻辑，无路由，无状态管理库。

## 安全模型（文件授权）

文件/文件夹必须先获得授权，主进程才允许读取。授权途径有且仅有三种：

1. **对话框选择** — 用户通过 Electron 原生打开文件/文件夹对话框选择
2. **拖放** — 用户将文件拖放到 app 窗口（`openDroppedMarkdownFile` 在 preload 中用 `webUtils.getPathForFile` 获取路径，isDropped=true 透传到主进程）
3. **最近记录恢复** — 启动时从 `recent.json` 中恢复所有仍存在的路径授权

授权状态存储在 `ipc.ts` 的 `authorizedFiles` / `authorizedDirs` Set 中（内存态），加上 `pathPolicy.ts` 中的目录包含判断（`isPathInsideDirectory`）。IMPORTANT: 测试模式下会额外允许 temp 目录路径，通过 `NODE_ENV`、`VITEST`、`PLAYWRIGHT_TEST` 等环境变量探测。

## Markdown 渲染管线

```
原始 markdown 文本
  → markdown-it 解析为 tokens（renderMarkdown.ts）
  → heading tokens 注入 id，生成 outline 数组
  → tokens 渲染为 HTML 字符串
  → DOMPurify 白名单消毒（ALLOWED_TAGS + ALLOWED_ATTR）
  → removeUntrustedImages 移除未标记 localImageToken 的图片
  → 结果 → renderer App.tsx useMemo 缓存
  → collectLocalImageResolutionGroups 从 HTML 中提取 data-local-src 图片
  → resolveImageGroupsWithLimit 通过 IPC 并发解析图片（并发数 4，上限 80 组）
  → applyImageResolutions 将解析结果（成功/失败）注入 HTML
  → applySearchHighlights 在 HTML 中标记搜索匹配（使用 DOM TreeWalker）
  → dangerouslySetInnerHTML 渲染到 DOM
```

关键点：
- 图片渲染时 markdown-it 不输出 `src` 属性，而是输出 `data-local-src` + `data-local-image-token`，由后续图片解析阶段再转为 `src`
- WYSIWYG 模式下用 MDXEditor (@mdxeditor/editor)，源码编辑模式下用 textarea + 静态 HTML 预览
- MDXEditor 会「规范化」本地相对链接为 `https://...` 格式，`restoreMdxNormalizedLocalLinks` 负责从草稿中还原这些链接

## 双编辑器模式同步

App.tsx 维护 `draftContent` 作为真实内容源，`viewState.document.content` 是上次保存的基准：

- **read 模式**：draftContent 注入 MDXEditor。用户编辑时通过 `onChange`/`onInputCapture`/`onKeyDownCapture` 触发 `scheduleReadEditorSync()`，用 `requestAnimationFrame` 防抖同步回 draftContent。同步时调用 `restoreMdxNormalizedLocalLinks` 还原 MDXEditor 的链接规范化。
- **source-edit 模式**：textarea 直接绑定 draftContent。右侧显示静态渲染预览。
- 切换模式时：离开 read 模式前强制 `syncReadEditorToDraft(true)`。

`mdxEditorTouchedRef` 跟踪 MDXEditor 是否有未同步更改，避免 `onChange` 的初始化回调污染 draftContent。

## 类型与 IPC 约定

- **共享类型**：`src/shared/documentTypes.ts` — 所有跨进程使用的类型（MarkdownDocument、各类 Result 类型、SecurityDiagnostics 等），统一使用 `{ ok: true, ...data } | { ok: false, code, message }` 的 Result 模式。
- **IPC 信道**：`src/shared/ipcChannels.ts` — 集中定义所有 IPC 信道字符串常量，`ALLOWED_IPC_CHANNELS` 列表供诊断面板展示。
- **类型声明**：`src/preload/types.ts` 定义 `MdViewerApi` 接口，`src/renderer/src/global.d.ts` 将其挂到 `Window` 上。

## 图片解析安全约束

`pathPolicy.ts` 的 `resolveDocumentRelativePath` 限制图片只能从两个位置读取：
1. 当前文档所在目录（`dirname(documentPath)`）
2. 已授权的 workspace 文件夹内（`allowedDirectories` 参数）

图片解析在 main 进程的 `imageAccess.ts` 中执行，检查文件存在性、是否为文件、扩展名白名单、文件大小限制（≤10MB），并返回 base64 Data URI。

## 未保存跟踪与关闭保护

- renderer 通过 `hasUnsavedChanges` 判断 draftContent 是否偏离 document.content
- 每次变化时通过 IPC `SET_UNSAVED_CHANGES` 通知主进程
- 主进程在 `window.on('close')` 中检查标记，弹出"继续编辑/放弃更改"确认对话框
- 切换文档时也通过 `confirmDiscardChanges` IPC 询问

## 测试分层

- **单元测试（Vitest）**：与实现文件同目录的 `*.test.ts`/`*.test.tsx`，mock Electron/Node API。分 8 个 stage 逐步累加运行。
- **E2E 测试（Playwright）**：`tests/e2e/stageN.spec.ts`，测试完整 app 工作流。单 worker 串行执行，30s 超时。
- **测试 fixtures**：`tests/fixtures/markdown/` 包含各种 markdown 样本（标题、列表、表格、代码块、链接）。
- **打包测试**：`tests/stage8/packaging.test.ts` — 仅检查构建配置（模块格式、asar、文件关联等）。

## 构建与打包

- `electron-vite` 管理三目标构建：main (ESM)、preload (CJS)、renderer (React + Vite)
- `electron-builder` 打包 Windows NSIS 安装包，配置在 `package.json` 的 `build` 字段
- CSP 在 `src/renderer/index.html` 中通过 `<meta http-equiv="Content-Security-Policy">` 设定
- 安装图标和 NSIS 脚本在 `build/` 目录

## 最近记录存储

`recentStore.ts` 将最近打开的文件/文件夹路径写入 `{userData}/viewer-state/recent.json`，上限 12 条。每次打开/保存文件或打开文件夹时更新，启动时恢复授权。记录包含 `exists` 字段反映当前文件系统状态。

## 命名与代码风格

- TypeScript strict 模式，不允许隐式 any
- 两空格缩进，单引号，分号
- `camelCase`：函数、变量；`PascalCase`：React 组件、类型；`UPPER_SNAKE_CASE`：IPC 信道键
- 命名导出优先
- React 组件不使用路由或状态管理库，纯 `useState`/`useRef`/`useMemo`
- CSS 在单个 `styles.css` 中，主题通过 `[data-theme="dark"]` 选择器切换。MDXEditor 和 highlight.js 各引入独立样式。

## 版本发布流程

1. 确保 typecheck 和测试通过：`npm run typecheck && npm test`
2. 更新 `package.json` 中的 `version` 字段（遵循 semver）
3. 运行 `npm run dist` 构建安装包到 `release/`
4. 清理 `release/` 中不需要发布的产物（如 `win-unpacked/`、旧的 portable `.exe`）
5. 打 annotated tag：`git tag -a vX.Y.Z -m "vX.Y.Z — <简要说明>"`
6. 推送 tag：`git push origin vX.Y.Z`
7. 创建 GitHub Release 并上传资产：
   ```
   gh release create vX.Y.Z "release/Markdown viewer Setup X.Y.Z.exe" \
     "release/Markdown viewer Setup X.Y.Z.exe.blockmap" \
     --title "vX.Y.Z" --notes "<更新说明>"
   ```
8. 推送提交：`git push origin main`
