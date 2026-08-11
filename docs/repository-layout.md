# 仓库目录说明

Vellora 的目录按运行代码、测试、维护工具、静态资源和本地产物分开。根目录保留
项目清单、构建与通用配置、前端入口、许可证、社区文档、变更记录和多语言 README。

| 目录 | 职责 | 是否提交 |
| --- | --- | --- |
| `.github/` | CI、Release、Dependabot 与社区模板 | 是 |
| `assets/icons/` | 图标设计源文件 | 是 |
| `docs/` | 当前仓库和发布流程文档 | 是 |
| `mac/` | macOS 配置、Universal 构建、验证脚本和桌面 E2E | 是 |
| `src/` | React 前端、Markdown 处理与交互 | 是 |
| `src-tauri/` | Rust/Tauri 后端、权限、图标和打包配置 | 是 |
| `tests/` | E2E、测试夹具和相关配置 | 是 |
| `tools/` | 图标、版本、发布产物和 WebDriver 维护脚本 | 是 |
| `artifacts/` | 当前安装包、macOS 验证包、WebDriver、E2E 截图等本地生成产物 | 否 |
| `dist/`、`src-tauri/target/`、`src-tauri/gen/schemas/` | 可重建的前端、Rust/Tauri 输出和能力 Schema | 否 |
| `node_modules/` | npm 安装依赖 | 否 |

本机的 `.agents/`、`.claude/`、`.codex/` 和 `.gitnexus/` 属于开发工具状态，均被
Git 忽略，不是公开仓库内容。新文件应放入最接近其职责的现有目录；不要重新创建
根目录 `release/`、通用 `build/` 或只有单个入口的 `scripts/`。macOS 专属实现统一放入
`mac/`，共享业务逻辑仍放在 `src/` / `src-tauri/`。
