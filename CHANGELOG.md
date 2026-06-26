# Changelog

## 1.2.1 - 2026-06-26

### 品牌更新

- 项目公开名称从 Markdown viewer 改为 Vellora；保留既有 `appId` 以延续 Windows 升级与文件关联身份。

## 1.2.0 - 2026-06-26

### 安全加固

- **主进程路径安全**：重构 `pathPolicy.ts`，新增 `isDangerousSystemDirectory` 函数，显式枚举 Windows/Unix 危险系统目录（`C:/Windows`、`/etc`、`/var` 等），并通过 `SystemRoot`、`ProgramFiles` 等环境变量动态读取，解决非 C 盘系统安装场景的遗漏。
- **符号链接穿越防护**：`ipc.ts` 新增 `resolveRealPathAndCheckDanger`，对符号链接执行 `lstatSync → realpathSync` 后再做安全检查，堵住符号链接绕过危险目录限制的漏洞。
- **图片路径安全**：`resolveImages.ts` 新增 UNC 路径拦截（防 Windows NTLM 凭据泄露）和伪协议过滤（`javascript:`、`data:`、`vbscript:` 等），仅允许 `file://` 及本地相对路径。
- **拖放授权统一**：移除原有 `isDropped` 参数绕过逻辑，拖入文件统一走 `handleUnresolvedFileAuthorization` 对话框授权流程。
- **DOMPurify hook 清理**：`renderMarkdown.ts` 将自定义 hook 移至 `finally` 块，防止全局 hook 泄漏；扩展禁止标签列表（`iframe`、`script`、`style`、`svg`、`math` 等）。

### 功能新增

- **最近记录删除**：新增 `REMOVE_RECENT_ITEM` IPC 通道；最近打开记录列表每项新增"×"删除按钮，支持单条移除并同步撤销文件授权。
- **过期记录交互优化**：过期（文件不存在）记录从"禁用"改为"可点击确认移除"，新增 `expired` 样式类区分状态。
- **目录折叠**：工作区侧边栏支持点击目录节点折叠/展开，`renderWorkspaceNodes` 重构为独立 `WorkspaceTree` 组件。
- **图片 Lightbox**：点击 Markdown 正文内图片可全屏预览，再次点击或按 Escape 关闭。
- **源码模式自动聚焦**：切换到源码编辑模式时，文本框自动获得焦点。
- **AppData 安全策略更新**：`AppData/Local` 和 `AppData/Roaming` 整体纳入危险目录，测试模式下通过 `isInsideTestTempDirectory` 允许 `os.tmpdir()` 绕过，避免影响 Vitest/Playwright fixture。

### 性能优化

- **工作区扫描提速**：`workspaceAccess.ts` 新增 `IGNORED_DIRECTORIES`（`node_modules`、`.git`、`dist`、`build`、`.next` 等），大幅减少 monorepo 场景的目录遍历耗时。
- **图片解析稳定性**：单张图片解析新增 10 秒超时与错误隔离，单图失败不影响整批；空文档跳过 DOM 重构。
- **搜索高亮性能**：`searchHtml.ts` 新增原始字符串预过滤、TreeWalker 节点预过滤、1000 匹配上限保护，避免超大文档 DOM 爆炸；修复重复 `replaceWith` 导致节点脱树的隐性 bug。

### Bug 修复

- **编辑器同路径刷新**：重新打开当前已打开的同路径文件时，MDXEditor 内容正确刷新。
- **模式切换后编辑器不更新**：从 source-edit 切回 read 模式时，`prevEditorModeRef` 触发强制 `setMarkdown`，修复内容不同步问题。
- **Escape 分层关闭**：Escape 键从"一次关闭所有覆盖层"改为按优先级逐层关闭（Lightbox → 外链确认 → 命令面板 → 文件详情 → 查找栏 → 设置 → 最近记录）；修复 stale closure bug（deps 数组从 `[]` 补全为实际依赖项）。
- **Windows 路径大小写去重**：`recentStore.ts` 修复 Windows 路径大小写不一致导致最近记录去重失效的问题。
- **侧边栏语义修复**：`hidden` 属性改为 `aria-hidden`，避免 CSS 被 HTML `hidden` 完全覆盖。
- **代码高亮主题隔离**：修复 hljs 选择器未区分 dark/light 主题，light 模式代码颜色错误的问题；补充 `number`、`literal`、`variable`、`tag`、`attr` 类型着色。
- **E2E 测试稳定性**：`stage7.spec.ts` 新增 `page.click('h1')` 强制 blur，修复关闭前"未保存"检测的输入焦点竞态；`stage1.spec.ts` fixture 路径改用 `homedir()` 避免 AppData 安全拦截。
- **测试幂等性**：`ipc.test.ts` 改用随机后缀命名临时文件，修复连续运行时 recentStore 残留导致的测试失败。

### 代码质量

- `getWindowsDangerousDirectories` 通过环境变量动态读取 Windows 系统路径。
- 移除 `isFileAuthorized` / `isDirAuthorized` 中重复的内联 `isTestMode` 判断，统一由 `isInsideTestTempDirectory` 处理。
- 新增 `App.mdxRefresh.test.tsx`，覆盖编辑器同路径重新加载行为。
- `CHANGELOG.md` 和 `AGENTS.md` 同步更新项目规范。

验证：

- `npm run typecheck`
- `npm test`
- `npm run test:e2e:stage1`
- `npm run test:e2e:stage7`

## 1.1.3 - 2026-06-25

- 更新 Windows 应用图标为白底深紫文档源码图形，并补齐 PNG/ICO 生成链。
- Windows 打包改为使用本地 Electron runtime，并在 `afterPack` 阶段写入 EXE 图标资源，避免缺少小尺寸图层。
- 源码模式改为全宽源码编辑器，不再同时显示实时渲染预览。
- 打包测试新增图标结构校验，覆盖 16/32/48/64/128/256 px ICO 图层。
- 修复图标母版测试过度绑定生成图尺寸的问题，改为校验正方形且不小于 256 px。

验证：

- `npm run test:stage8`
- `npm test`
- `npm run generate:icon && npm run test:stage8`
- `npm run dist`
