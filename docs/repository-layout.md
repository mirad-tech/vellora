# 仓库目录说明

Vellora 的目录按运行代码、测试、维护工具、静态资源和本地产物分开。根目录保留
项目清单、构建与通用配置、前端入口、许可证、社区文档、变更记录和多语言 README。

| 目录 | 职责 | 是否提交 |
| --- | --- | --- |
| `.github/` | CI、Release、CodeQL、Dependabot 与社区模板 | 是 |
| `assets/icons/` | 图标设计源文件 | 是 |
| `docs/` | 当前仓库、发布流程文档与公开预览图 | 是 |
| `mac/` | macOS 配置、Universal 构建和验证脚本 | 是 |
| `src/` | React 前端、Markdown 处理与交互 | 是 |
| `src-tauri/` | Rust/Tauri 后端、权限、图标和打包配置 | 是 |
| `tests/` | Markdown 单元测试夹具 | 是 |
| `tools/` | 图标、版本和发布产物维护脚本 | 是 |
| `artifacts/` | 安装包、构建验证记录等本地生成产物 | 否 |
| `dist/`、`src-tauri/target/`、`src-tauri/gen/schemas/` | 可重建的前端、Rust/Tauri 输出和能力 Schema | 否 |
| `node_modules/` | npm 安装依赖 | 否 |

本机的 `.agents/`、`.claude/`、`.codex/` 和 `.gitnexus/` 属于开发工具状态，均被
Git 忽略，不是公开仓库内容。新文件应放入最接近其职责的现有目录；不要重新创建
根目录 `release/`、通用 `build/` 或只有单个入口的 `scripts/`。macOS 专属实现统一放入
`mac/`，共享业务逻辑仍放在 `src/` / `src-tauri/`。

## 前端职责边界

- `App` 组合页面、目录与快捷键；文件请求、保存、冲突和原生事件由文档会话统一处理。
- `useDocumentSession` 只通过 `state`、`actions` 和 `editorBindings` 对接界面。请求编号、同步引用、组合输入等待队列和待执行确认回调留在会话内部。
- `DocumentEditor` 维护连续文档及保存快照；`SourceEditor` 维护源码文本框、搜索镜像和选区测量。视图位置模块保存两种模式的阅读位置，搜索协调模块通过编辑器句柄定位结果。
- 图片由一个文档会话队列调度，保持图片源上限、并发限制、超时和旧会话结果隔离。标题 ID 由共享纯函数生成，解析与内容保留规则仍由原有 Markdown 模块维护。
- `ConfirmationDialogs` 只展示会话提供的数据并调用操作，焦点管理复用 `useDialogFocus`。重构时保留现有 DOM、文案和文档编辑器的挂载周期。
