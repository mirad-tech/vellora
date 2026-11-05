# Vellora 本地临时整合审查记录

本次在独立 worktree 中审查并整合本地当前实现与指定远端交付。采用按功能移植：本地已从旧式块编辑迁移为连续编辑器，并拆分会话、搜索、图片与焦点职责；直接合并远端旧版 `App.tsx` 会重新引入已移除的编辑逻辑。没有使用整文件 ours/theirs，也没有将远端历史截图当成本轮 before。

## 对照对象与保护证据

| 对象 | 值 |
| --- | --- |
| 原工作目录 | `G:\mirad\mirad-server\md` |
| 原分支 / HEAD | `main` / `57a0d298d8c735dfbea4087b8f331f98b91d798b` |
| 原暂存区 | 空；原分支比当时的 `origin/main` 领先 2 个提交 |
| 本地基线快照 | `0c6127eacbccca3a45b530e2b4b2674446d2a8cb` |
| 远端固定交付 | `0f511b04d211e35a0f5cb521a60823b007d2d9e7` |
| 远端功能提交 | `ec67cf6d6134b2f3957b39cb6c8ec921dcc29340` |
| 实际共同祖先 | `7f0bd506d1aa81d463d6f6cdd54980240a18522a`，由 `git merge-base` 计算 |
| fetch 后远端分支 | `origin/codex/vellora-ui-polish-20261106` 正好等于固定交付；没有新增提交 |
| 临时整合分支 | `local/vellora-ui-integration-20261106` |
| 临时整合目录 | `G:\mirad\mirad-server\vellora-ui-integration` |
| before 独立副本 | `G:\mirad\mirad-server\vellora-ui-baseline`，detached 于本地快照 |
| 外部备份与日志 | `G:\mirad\mirad-server\vellora-ui-integration-backup-20261106` |

建立 worktree 前，保存了原索引的二进制副本、已暂存/未暂存二进制完整补丁、未跟踪清单和文件 SHA-256 清单。复制核对覆盖 116 个路径的存在状态及实际字节，包括删除记录；本地快照显式暂存 77 个经过识别的路径。两份临时文本 `src/markdown/.write-check.txt`、`tools/_fence-impl.txt` 保留在原目录、外部备份和整合目录的未跟踪副本中，未加入提交或产品入口。

外部证据包括 `manifest.json`、`copy-verification.json`、`original.index`、`status.porcelain-z`、`staged.patch`、`unstaged.patch`，以及三组完整差异 `ancestor-local.patch`、`ancestor-remote.patch`、`local-remote.patch`。提交快照不修改原分支历史；未在原目录执行 stash、reset、clean 或 checkout。

远端最后一个提交经 `git diff ec67cf6 0f511b0` 核对，只修改设计/验收文档并新增原生截图。已通过 GitHub 连接器读取 [42094282845 的作业与步骤](https://github.com/mirad-tech/vellora/actions/runs/42094282845)，其 Windows 验证成功；该记录只作为远端功能提交的证据，本次所有结论仍依据本地验证。

## 分组审查与取舍

| 分组 | 结论 | 依据、实际选择与影响 |
| --- | --- | --- |
| 视觉令牌、工具栏、正文与响应式 | **融合两边** | 本地已具备同一中性浅色方向、系统无衬线正文、独立等宽源码、52/80px 工具栏、1024px 目录断点、独立错误反馈行及保存/查找入口。保留这些实现和现有图标；吸收远端 96px 表格最小列宽、目录关闭按钮、无额外宽度的命中标记与必要可访问性语义。 |
| 编辑、保存、搜索、输入法、确认与关闭 | **保留本地核心，融合远端交互修正** | 本地连续编辑、原始 Markdown 保留、撤销/模式切换、保存时 flush、输入法保存等待、保存并发与外部冲突均比远端旧式 quick-edit 覆盖更完整。保留本地会话入口；搜索定时聚焦可取消并服从确认框/打开状态，重复查找保留查询，组合输入键不触发全局快捷操作；保留唯一焦点管理器并采用明确的安全初始焦点，原生关闭确认初始聚焦容器。 |
| 测试、截图、Windows 驱动与 CI | **融合并适配本地结构** | 本地已删除旧 E2E 与工具依赖，远端烟测仍依赖旧编辑器。恢复适用场景为独立测试工具，浏览器 mock 仅注入临时测试页面，原生使用真实 IPC；按本机注册的 WebView2 Runtime 匹配驱动并保留 Microsoft 签名校验、独占会话与清理约束。CI 单独判断，不把历史 131 Runtime 当作本机要求。 |

没有吸收远端的旧编辑/搜索 HTML 算法、旧 `App.tsx` 单体结构、重复的 `components/useDialogFocus`、整套覆盖式 CSS、单独 `AppIcon` 抽象和历史图片。已有本地图标和内联 SVG 能满足这次控件需求，无需再建第二套控件体系。保留源码现有 `tab-size: 2`，textarea 与高亮层共用规则；不为对齐远端规格而改动编辑显示习惯。

远端曾通过 Windows 2022 环境的证据只用于测试工作流选择，未降级、安装或替换本机 WebView2 Runtime。没有扩大 Tauri capability、CSP、外链协议、文件扩展名、相对路径或图片大小边界。

## 保留的其他本地任务修改

- 两个已有本地提交包含的仓库治理、公共文档、依赖固定及编辑器实现。
- `src/editor/` 连续编辑与原始 Markdown 元数据保留、源码位置映射、编辑上下文与性能回归。
- `src/session/` 会话状态、保存错误恢复、打开时序与关闭保护；`src-tauri/src/reliable_save.rs` 可靠替换、外部修改检测与冲突令牌。
- 图片异步解析、源码目录、视口/光标状态，以及现有前端与 Rust 回归。
- 本地版本号、README/CHANGELOG/CONTRIBUTING、仓库目录说明、第二阶段计划、CI 与 release 的既有修改。
- 本地删除的 macOS 目录以及旧 quick-edit/旧 E2E 实现的删除意图。适用的 E2E 能力以隔离测试工具恢复，没有恢复旧产品测试插件或正式入口中的测试探针。

**已有问题保留为明确限制：** 本地删除了 `mac/`，但 `package.json` 和原 `.github/workflows/ci.yml` 仍引用其中脚本，因此现有 macOS 构建/CI 入口悬空。这属于快照已存在、与本轮 Windows UI 整合无关的修改，未擅自恢复 macOS 文件或改变既有发布流程。本轮不能据 Windows 通过宣称整个跨平台 CI 已通过。

## 影响分析与冲突处理

GitNexus 索引绑定原工作目录。对 `App`、`useDocumentSearch`、`useDialogFocus`、`ConfirmationDialogs` 的 upstream 分析返回 `UNKNOWN`，没有将其解释为低风险。当前源码核对得到：`src/main.tsx → App`，`App → useDocumentSearch / ConfirmationDialogs`，`ConfirmationDialogs → useDialogFocus`，`SearchPanel` 只消费搜索 hook 的返回值。整合影响工具栏/目录、搜索聚焦和弹窗键盘交互；保存与编辑器命令保持原入口及接口。

提交前调用了 `detect_changes`。其原目录结果包含 193 个符号、52 个流程并给出 critical，反映原有整批本地编辑/保存重构的规模，不能用作新 worktree 的精确范围。新 worktree 的 staged diff、实际调用关系和验证结果另行复核；本次 UI 产品提交没有更改 Rust、编辑器、Markdown 解析或对外 API。

这次采用功能移植，没有制造或批量解决文本冲突。处理的语义冲突包括：旧 quick-edit 与连续编辑器不能并存；两套焦点管理器不能同时监听；搜索延迟 focus 需要让位于确认框；表格旧最小列宽与新正文排版需要统一。CSS 在现有规则处修改，弹窗 URL 改用明确选择器优先级，移除两处普通样式 `!important`；减少动态效果的全局覆盖保留。

实际发现并处理的验证问题：

1. **快照已有依赖恢复失败。** `npm ci` 报锁文件缺少 `@floating-ui/dom@1.8.0`。现有 Tiptap 可选依赖已要求该包，本机原 `node_modules/.package-lock.json` 也已经使用这一版本。仅补全它的 11 行锁记录，恢复后 `npm ci` 成功；逐项比较确认所有已有锁项未变，没有升级依赖。
2. **整合中新出现重复错误播报。** 初次把所有工具栏错误设为 `alert`，导致编辑器恢复提示与工具栏重复；既有测试捕获。现在只有保存错误在工具栏使用 `alert`，编辑器错误保持原有播报位置，全部前端测试重新通过。
3. **新测试构建目录影响开发服务。** 原生测试最初写入 `artifacts/desktop-e2e-target`，Vite 监听 Windows 构建 EXE 时出现 `EBUSY` 并退出。停止本次独占构建、确认子进程退出后，将测试 target 移到既有忽略范围 `src-tauri/target/desktop-e2e`；无监听需求的测试 Vite 关闭 watcher，真实开发服务重启后 HTTP 200。未用产品配置扩大忽略范围来掩盖问题。

## 本地验证

环境：Windows x64，Rust/Cargo `1.97.0`；使用本机已有 Node `24.22.1` 与 npm `11.21.1`。系统默认 Node `24.13.0` 低于项目和 jsdom 的 engines 要求，未修改系统安装。测试专用 Edge 驱动与本机 WebView2 均为 `156.0.4314.58`，签名为 `Valid`、签发主体包含 Microsoft Corporation。

| 检查 | 本地快照 before | 整合版 after |
| --- | --- | --- |
| `npm ci` | 原锁失败；仅补缺项后成功 | 已成功恢复；无已有依赖升级 |
| `npm run version:check` | 通过，2.4.2 | 通过 |
| `npm run typecheck` | 通过 | 通过 |
| `npm test` | 10 文件、268 测试通过 | 10 文件、272 测试通过 |
| `npm run test:rust` | 51 通过、0 失败 | 51 通过、0 失败 |
| `npm run build:web` | 通过 | 最终产品代码构建通过 |
| `npm run test:e2e` | 原快照没有该脚本，未伪造基线通过 | 5 组综合场景通过，包括 9 个精确宽度、源码高亮度量及减少动态效果 |
| `npm run test:e2e:desktop` | 原快照没有该脚本；另有真实 native before 操作取证 | 真实 Tauri IPC 综合回归通过，退出码 0；独占会话和临时文件清理通过 |

新增的 4 项前端测试在现有 `src/App.test.tsx` 中，保护：未失焦正文首次点击保存与失败重试；IME 键与重复查找；延迟搜索遇到原生关闭确认时的焦点、Tab、Escape；目录关闭与外部目标点击。未写源码字符串测试，也未跳过或削弱原有断言。

Web 构建仍提示约 990 kB 的主 JS chunk 超过默认 500 kB 阈值，这是 before 已有提示；本轮不以拆包重构扩大范围。没有运行 `npm run dist`、NSIS、DMG 打包、发布、push、PR 或远端评论。

## 截图与人工操作证据

本轮 before 的产品源码来自本机当前快照 `0c6127e`，after 来自该快照上的本地整合。综合文档来自远端 `06-ui-polish.md`，仅作测试 fixture，包含中英文、长标题、表格、长代码、链接与缺失图片，不进入正式入口。

- 原生 before：`G:\mirad\mirad-server\vellora-ui-integration-backup-20261106\screenshots\before-native`，12 张。
- 原生 after：`G:\mirad\mirad-server\vellora-ui-integration-backup-20261106\screenshots\after-native`。
- 原生窗口 before 逻辑尺寸为 822×932、1284×932、646×932，内容区约 820×900、1282×900、644×900。拖动不能精确达到全部目标尺寸，未标称为精确 1280 或 640。
- 浏览器前后对照、精确 viewport/DPR 与自动化度量见最终验收补充；与原生证据分别标注，不互相替代。

原生应用为真实 Tauri debug 可执行文件配合实际 Vite 开发服务。仅通过临时 `TAURI_CONFIG` 为 before/after 提供不同 identifier，避开已安装 Vellora 的单实例互斥；该覆盖没有写入产品配置。测试用文件为独占副本，保存操作回读磁盘字节并恢复；没有操作现有安装版的文档。

**待人工验收：** 真实中文输入法候选词选择；Windows 125%/150% 显示缩放；原生最小高度 400px。自动派发 composition 事件、浏览器 DPR 或窗口截图不能代替这些系统级操作。

## 本地运行与回退

本轮所有提交只在 `local/vellora-ui-integration-20261106`。原 `main` 未合并整合内容，原分支也未推送。已知本地提交：

| 提交 | 职责 |
| --- | --- |
| `0c6127e` | 原工作区本地基线快照 |
| `524e963` | 补全已有可选依赖锁记录 |
| `d1898f9` | 融合目录、搜索、确认焦点与版式改进，以及 4 项行为回归 |
| `0008e1c` | 适配独立浏览器/原生测试、Runtime 匹配、截图与 UI 工作流 |

使用 Node 满足项目 engines 后，在整合目录运行 `npm run dev` 即为通常开发方式。如果已安装版仍运行，可能触发其单实例行为；本次隔离启动命令和测试准备命令见最终验收补充。

需要查看整合前版本时，可直接使用现成 `vellora-ui-baseline` 副本；它的产品源码保持快照，仅补了相同锁文件缺项以便恢复依赖。需要另建完全独立快照副本可运行：

```powershell
git -C G:\mirad\mirad-server\md worktree add --detach G:\mirad\mirad-server\vellora-ui-snapshot-review 0c6127eacbccca3a45b530e2b4b2674446d2a8cb
```

这不会切换或清理原工作目录。撤销本次整合体验时关闭临时实例即可；不需要修改原 `main`，也无需执行破坏性 Git 回退。

## 最终验收补充

### 完成状态与证据

所有本轮要求且适用于本机 Windows 的检查已完成。5 组浏览器综合场景为保存、搜索、布局/目录、确认/错误恢复、减少动态效果。实际覆盖 `640/759/760/761/820/1023/1024/1025/1280` 像素宽、52/80px 工具栏、232/248px 目录宽度、跨断点开关状态、Enter/Shift+Enter/组合输入事件、重复查找、长错误下操作区域几何，以及 textarea/高亮层字体、字号、行高、宽度、内边距、换行、tab-size 和共用滚动。

原生自动化通过 CLI 打开真实临时文件，验证正文首次按钮保存、源码 Ctrl+S 和 CRLF 回读、本地链接取消、失败跳转后草稿仍可保存、恢复文件后成功跳转、搜索/目录、外链取消，以及外部修改时先拒绝写盘、二次确认后覆盖。实际生成 6 张 WebView 截图，内容区 `820×900`、DPR `1`。这组使用专门的 IPC 测试样本，与同场景 before/after 对照分开。

原生人工式界面检查还验证了只读文件保存失败后的真实磁盘状态与恢复重试。before/after 的测试副本均恢复原字节，SHA-256 为 `3b4f21f47b85cb463d5fa62a7fa50ba9996bab42f3b539a294c9ea226e3fd97c`，最终不再只读。关闭确认初始焦点为容器，首次 Tab 到“继续编辑”；外链确认初始焦点为“取消”。没有实际访问外链。

| 证据 | 位置 |
| --- | --- |
| 版本、类型、单测、Rust、Web 构建日志 | `G:\mirad\mirad-server\vellora-ui-integration-backup-20261106\baseline-*.log`、`integration-*.log`；带 `final` 的日志是对应修正后的最终结果 |
| 原生 before/after 记录和尺寸清单 | [after-native-review.md](G:/mirad/mirad-server/vellora-ui-integration-backup-20261106/after-native-review.md) |
| 原生 before 12 张 / after 15 张 | `G:\mirad\mirad-server\vellora-ui-integration-backup-20261106\screenshots\before-native` / `after-native` |
| 浏览器同场景 before 9 张 / after 9 张 | `G:\mirad\mirad-server\vellora-ui-integration\artifacts\ui-review\before` / `after`；各有 `metrics.json` |
| 5 组浏览器综合回归截图 | `G:\mirad\mirad-server\vellora-ui-integration\artifacts\ui-review\browser` |
| 原生自动化日志 | [desktop-e2e.log](G:/mirad/mirad-server/vellora-ui-integration/artifacts/ui-review/desktop-e2e.log) |
| 原生 IPC 截图、Runtime/驱动与视口度量 | `G:\mirad\mirad-server\vellora-ui-integration\artifacts\ui-review\desktop` |

主代理回读两份浏览器 metrics：9 组场景一一对应，同一文档名称及 SHA-256、相同 viewport 和 DPR `1`，18 个场景的运行时错误与页面横向溢出均为 0；并查看宽/窄文档、源码搜索、目录、长错误以及原生截图。before 元数据指向 `0c6127e`，after 指向产品提交 `d1898f9`；截图当时工作区因测试工具与记录尚未提交而标为 dirty，另用 Git diff 确认产品 `src/` 与对应提交一致。

实际 `dist`、`src/main.tsx`、正式 Vite 配置与 Tauri 配置中未发现本次测试 bridge、测试标记或 fixture 入口；测试依赖仅在 `tests/e2e/tooling`，浏览器响应只注入一次性页面。Rust、API、capability、permissions、Cargo 锁和产品 Tauri 配置相对快照无新增差异。未生成安装包。

原生测试结束后回读没有本次 Vellora、tauri-driver、msedgedriver 进程残留，独占临时 fixture 已清理；本次开发 Vite PID 32060 在确认归属后停止，1420 端口已释放。原安装版进程未由本次测试停止或操作。

### 本轮整合实际修改文件

以下是相对快照的整合增量；快照中的 77 个本地路径另见外部 `snapshot-stage-paths.txt`，不混记为本轮新实现。

| 用途 | 文件 |
| --- | --- |
| 产品交互与样式 | `src/App.tsx`、`src/styles.css`、`src/ui/ConfirmationDialogs.tsx`、`src/ui/useDialogFocus.ts`、`src/ui/useDocumentSearch.ts` |
| 行为回归 | `src/App.test.tsx` |
| 依赖恢复与命令入口 | `package-lock.json`、`package.json` |
| 浏览器测试与隔离依赖 | `tests/e2e/browser-fixture.mjs`、`tests/e2e/smoke.mjs`、`tests/e2e/tooling/chromium.mjs`、`tests/e2e/tooling/package.json`、`tests/e2e/tooling/package-lock.json` |
| 原生测试 | `tests/e2e/run-desktop.mjs`、`tests/e2e/smoke.desktop.mjs`、`tests/e2e/webdriver.mjs` |
| 截图、样本与使用说明 | `tools/verification/capture-ui-review.mjs`、`tests/fixtures/markdown/06-ui-polish.md`、`tests/e2e/README.md` |
| Windows 驱动与 CI | `tools/webdriver/fetch-msedgedriver.mjs`、`tools/webdriver/webview2-runtime.mjs`、`.github/workflows/ui-validation.yml` |
| 审查与交付记录 | `LOCAL_UI_INTEGRATION_REVIEW.md` |

### 直接启动体验

本机已恢复依赖。以下使用本机已有的合规 Node，并读取仓库外的临时配置，仅为开发实例隔离 identifier；不改产品配置或系统安装。

```powershell
Set-Location 'G:\mirad\mirad-server\vellora-ui-integration'
$velloraNodeDir = 'C:\Users\ASL\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$env:Path = "$velloraNodeDir;$env:Path"
& "$velloraNodeDir\node.exe" .\node_modules\@tauri-apps\cli\tauri.js dev --config 'G:\mirad\mirad-server\vellora-ui-integration-backup-20261106\integration-dev.json'
```

通常可在该终端按 Ctrl+C 停止开发服务；应用关闭仍经过其原有未保存保护。自行使用已符合 engines 的 Node 时，也可运行 `npm run dev -- --config <同一配置文件路径>`。

重新运行 E2E 的准备与命令见 [tests/e2e/README.md](G:/mirad/mirad-server/vellora-ui-integration/tests/e2e/README.md)。本机已装 tauri-driver 2.0.6 并缓存签名匹配的 Edge 驱动，无需为这次体验再次安装，也无需降级 WebView2。

### 未完成项和保留限制

- 真实中文输入法选词、系统 125%/150% 缩放、原生 400px 高度仍待人工验收。原生 UI 对照未直接读取两轮 DPI；仅能确认同一系统会话内未主动改变缩放、窗口截图尺寸一致。额外的原生 WebDriver after 度量为 DPR 1，不能追溯替代 before 的 DPI 记录。
- macOS 悬空脚本/CI 是本地快照已有问题，本机未跑 macOS；没有恢复其文件、改变发布工作流或宣称跨平台门禁通过。
- 新的 GitHub Actions UI 工作流已按本地固定 action 版本静态审查，但未推送或远端触发。
- 隔离测试工具按原版本锁定 Puppeteer 25.5.0。其传递依赖 `zod` 命中已公开的内存耗尽公告，npm audit 沿传递链列为 3 项 high；不属于应用依赖或产品包。本轮按“不升级依赖”要求保留版本，后续需单独维护该测试工具依赖。[GitHub Advisory GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)

原工作目录最终完整性核对结果写入外部 `original-verification-final.json`：文件内容/删除状态、未跟踪清单、原 HEAD/分支、Git 状态及索引二进制副本均与开始时一致。整合目录除两份明确保留的原有临时文本副本外，提交内容独立可审阅。
