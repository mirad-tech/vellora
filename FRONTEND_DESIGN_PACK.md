# Vellora 中性浅色界面精修

## 基线与范围

- 代码基线：`mirad-tech/vellora` 的 `7f0bd506d1aa81d463d6f6cdd54980240a18522a`。
- 实施分支：`codex/vellora-ui-polish-20261106`。按仓库所有者本轮授权建立分支并提交，不合并主分支或发布安装包。
- 所有者在本机完成但尚未上传的第一轮改动不可见。本分支从上述远端基线独立实现，后续与本地版本合并前需对照差异。
- 参考：[Open Claude UI 4.16336.0 设计令牌](https://github.com/Caho1/open-claude-ui/blob/cd57febecb3d1a36eb1d2e9ad89ccefb27352a2e/docs/v4.16336.0/01-总体架构与设计令牌体系.md)，以及[基础控件](https://openclaudeui.com/docs/components/atoms)、[会话交互](https://openclaudeui.com/docs/components/conversation)。版本以锁定文档为准，以下数值为 Vellora 的明确适配值。

本轮围绕现有阅读、正文直接编辑、源码编辑、保存、查找、目录与确认界面展开。保持系统无衬线字体、浅色模式、Vellora 图标和原生标题栏。使用 React 与原生 CSS，没有增加组件库、动效库、主题设置或编辑器能力。

## 采用的规格

| 项目 | Vellora 适配值 |
| --- | --- |
| 表面 | 底层/侧栏 `#f9f9f7`；文档 `#fcfcfb`；浮层 `#ffffff` |
| 文字 | 主文字 `#0b0b0b`；必要说明/小号状态 `#52514e`；`#898781` 用于禁用状态 |
| 边界/焦点 | 主文字 10%/20% 边界；链接 `#184f95`；焦点 `#2466b8`、2px 描边 |
| 字体 | 界面和正文使用 Segoe UI Variable、Segoe UI、PingFang SC、Microsoft YaHei UI 等系统无衬线；源码/代码使用 Cascadia Code、Consolas 等等宽字体 |
| 控件 | 常规高 32px、圆角 8px；紧凑图标 28px；图标 16px、1.5px 描边 |
| 工具栏 | 52px；窗口宽度小于 760px 时 80px，文件名与状态进入第二行 |
| 模式切换 | 1px 内缩轨道、独立白色滑块；文档/源码保持真实 `aria-pressed` 状态 |
| 目录 | 1024px 以上停靠 232px；以下浮层 248px；条目 32px、每级缩进 12px、长标题提示 |
| 正文 | 最大外宽 800px，含左右 32px 内边距；小于 760px 时左右 20px；顶部 32px |
| 排版 | 正文 16px/1.75；H1/H2/H3 为 30/24/20px；首块无额外上边距，H1 无装饰横线 |
| 源码 | 14px/1.7、制表宽度 4；textarea 与高亮覆盖层共用全部文字和尺寸规则 |
| 内容块 | 代码块 12px 圆角、14px 等宽字；表格/长代码在自身容器横向滚动 |
| 搜索 | 宽 360px，距工作区顶部 8px；查询行 40px、导航行 32px、边框各 1px，因此外高 42/74px；圆角 14px |
| 搜索颜色 | 普通命中 `#e4ecf8`，当前命中 `#bdd3f1`，不增加文字内边距 |
| 确认弹窗 | 最大宽 440px、内边距 24px、圆角 16px；双层轻阴影 |
| 动效 | hover 60ms；滑块 120ms；浮层/展开 200ms；out `cubic-bezier(.165,.84,.44,1)`；snap `cubic-bezier(.32,.72,0,1)` |
| 减少动态效果 | 关闭 CSS 动画/过渡/位移动效，搜索定位使用即时滚动；选中状态仍完整显示 |

## 操作与状态决策

1. **保存复用现有入口。** 可见按钮调用 `handleSave`，包含正文直接编辑尚未提交的候选内容。按钮在无文档、未修改、打开中或保存中禁用，保存过程保持按钮宽度稳定；快捷键沿用现有保存流程。
2. **查找复用同一动作。** 按钮与 Ctrl/Cmd+F 均打开并聚焦现有搜索；已打开时再次操作只聚焦。查询、计数、上下项与源码高亮继续使用原算法。
3. **反馈与操作区分离。** 文件状态使用短文案，长错误全文展示在工具栏下方的真实 `role=alert` 区域。搜索定位于工作区，不使用固定的全局顶部距离。
4. **窄屏目录按关闭原因处理焦点。** Escape 和关闭按钮返回目录按钮；外部 pointerdown 仅观察事件并关闭，不消耗底层控件的点击；选择标题关闭后继续原定位流程。跨越断点保留目录开关状态。
5. **浮层拥有清楚的键盘顺序。** Escape 优先处理外链确认、未保存确认、搜索、目录。确认框限制 Tab 焦点并恢复合理焦点；关闭确认初始聚焦容器，避免默认聚焦破坏性操作。外链与关闭确认同时到来时，先处理外链，再展示保留的未保存确认。
6. **尊重输入法。** 全局快捷键和搜索跳过组合输入事件；已由正文直接编辑处理的 Escape 不继续关闭其他面板。

## 编辑前影响分析与边界

当前会话没有可用的 GitNexus 项目影响结论，不能把此前本地 `UNKNOWN` 当作低风险证据。本次直接核对当前源码的调用链：

| 修改位置 | 调用与影响范围 | 对应保护 |
| --- | --- | --- |
| `src/App.tsx` 工具栏与反馈 | 使用现有 `handleSave`、`draftRef`、`commitQuickEdit`、保存状态、打开请求状态 | 验证直接编辑候选内容、保存中/打开中禁用、失败恢复 |
| `src/App.tsx` 搜索/目录 | 使用现有查询匹配、源码覆盖层、标题定位和活动标题计算 | 保留 `.content` 滚动容器；验证键盘、输入法、浮层外点与焦点恢复 |
| `src/components/useDialogFocus.ts` | 管理可见确认框的焦点；不调用 Tauri | 保留原取消/放弃/保存后关闭回调及禁用条件，处理延迟搜索焦点与确认框的竞争 |
| `src/components/AppIcon.tsx` | 统一展示图标，无业务状态 | SVG 隐藏于辅助技术，按钮保留明确名称 |
| `src/styles.css` | 全部可见区域与源码高亮的几何关系 | 共享源码度量规则；检查断点、长内容、减少动态效果 |
| 回归测试与 UI 工作流 | 单元测试、浏览器截图、Windows 原生回归 | 测试样本与真实用户文件隔离；只生成测试可执行文件，不打安装包 |

后端命令、API 数据结构、文件格式、会话状态、文件访问策略、Markdown 渲染与编辑器接口均保持原有实现；依赖及锁文件不变。

## 验收证据与运行方式

### 当前记录

- 原始基线：`npm ci`、版本一致性、类型检查、94 项单元测试、Web 构建通过。
- 修改后：类型检查、Web 构建、6 个测试文件中的 98 项单元测试已通过（原基线为 94 项）。新增回归覆盖保存按钮候选内容与禁用状态、查找入口、输入法 Escape、窄目录关闭和焦点、确认框 Tab 约束及取消后的编辑器恢复。
- 本地 Linux 环境缺少 `cargo`；官方 Chromium 下载返回访问受限页面，因此本地未产生浏览器或 Tauri 窗口验收证据。
- 分支专用 **UI validation** 工作流在 Windows 上运行完整门禁、同场景前后截图和原生桌面 E2E。工作流结果及产物是远端验证依据；配置了检查不等于检查已通过。

### 同场景截图

固定综合文档为 `tests/fixtures/markdown/06-ui-polish.md`，覆盖中英文、多级长标题、表格、长代码、行内代码、链接和缺失图片提示；文件名使用长中文名称。

`tools/verification/capture-ui-review.mjs` 使用真实 Chromium 渲染当前源码，以测试用 Tauri 模拟响应构造空白、错误与确认状态。它的截图说明视觉表现，不代替原生 IPC 验证。相同脚本分别渲染锁定基线和当前代码，捕获 1280×900、820×900、640×900 文档与默认宽度下的关键状态。

```powershell
# 需要可用的 Chrome；必要时设置 BROWSER_PATH。
node tools/verification/capture-ui-review.mjs

# 使用其他已恢复依赖的源码目录进行对照。
$env:VELLORA_UI_REVIEW_ROOT = 'C:\work\vellora-baseline'
$env:VELLORA_UI_REVIEW_LABEL = 'before'
node tools/verification/capture-ui-review.mjs
```

Windows 原生测试使用 `tauri-driver` 与对应 Edge 驱动，运行真实应用及 IPC；测试中验证可见保存按钮、源码快捷键、文件跳转、搜索、目录和外链取消，输出原生 WebView 截图。工作流先上传 `vellora-ui-comparison-windows` 供对照查看，最终产物 `vellora-ui-review-windows` 汇集对照截图、渲染度量和原生截图。

### 最终门禁

```text
npm run version:check
npm run typecheck
npm test
npm run test:rust
npm run test:e2e
npm run build:web
```

人工复核还需关注 Windows 显示缩放、真实中文输入法选词、最小高度 400px，以及 759/760/761px、1023/1024/1025px 断点附近；任何尚未执行的检查都应记录为待验收。
