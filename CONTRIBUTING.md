# 贡献指南

感谢你改进 Vellora。本项目面向 Windows 与 macOS 的本地优先 Markdown 阅读与轻量编辑；Windows 提供正式 Release，macOS 保持源码、构建与 CI 支持。提交应保持这一范围，并优先保证文件安全、权限最小化和可恢复性。

## 开始之前

- 参与本项目即表示同意遵守 [社区行为准则](CODE_OF_CONDUCT.md)。
- Bug 与功能建议请使用对应的 Issue 模板。
- 安全漏洞不要公开提交，按 [安全策略](SECURITY.md) 私下报告。
- 大范围功能、权限或发布流程变更请先开 Issue 对齐范围。
- 不要在样本、日志或截图中提交真实私密文档。

## 本地环境

- Windows：Windows 10/11、Node.js 22.13+（22.x）或 24+、Rust MSVC 工具链、Visual Studio C++ Build Tools 和 Microsoft WebView2 Runtime
- macOS：macOS 12+、Node.js 22.13+（22.x）或 24+、Rust stable、Xcode Command Line Tools，以及 `aarch64-apple-darwin`、`x86_64-apple-darwin` 两个 Rust target

```
npm install
npm run dev
```

主要目录：

- `src/`：React、Markdown 渲染与前端交互
- `src-tauri/`：Rust/Tauri 文件操作、链接处理和桌面生命周期
- `mac/`：macOS 配置、Universal 构建、验证脚本与桌面 E2E
- `tests/`：单元测试、浏览器 E2E 与 Markdown 样本
- `.github/workflows/`：持续集成与标签发布

## 变更原则

- 只打开和保存 `.md` / `.markdown`。
- 本地图片与 Markdown 链接只能解析到当前文档目录内，图片不超过 10 MiB。
- HTTP(S) 外链必须由用户确认；拒绝危险协议。
- 不授予通用文件系统、Shell 或任意网络权限。
- 前端调用后端时沿用 `{ ok: true, ... } | { ok: false, code, message }`。
- 保留未保存关闭保护、单实例行为和现有中文功能文案。

涉及文件打开/保存、图片、链接、搜索或关闭保护时，至少同时运行前端与 Rust 单元测试。

## 提交前验证

```powershell
npm run version:check
npm run typecheck
npm test
npm run test:rust
npm run test:e2e
npm run build:web
```

Windows 桌面 E2E 依赖 `tauri-driver` 和本机 Edge 对应版本的 `msedgedriver`，不作为普通 PR 的必需本地检查：

```powershell
cargo install tauri-driver --locked
npm run tools:msedgedriver
npm run test:e2e:desktop
```

macOS 桌面 E2E 使用仅测试构建启用的内嵌驱动；运行 `npm run test:e2e:mac`，环境和验收边界见 [macOS 构建与验证说明](mac/README.md)。

## Pull Request

- 一个 PR 聚焦一个问题，避免混入无关格式化或生成文件。
- 说明用户可观察变化、风险边界、实际验证结果和未验证项。
- UI 变化附截图，并覆盖适用的空、加载、错误、禁用与权限受限状态。
- 不提交 `node_modules/`、`dist/`、`src-tauri/target/`、`release/` 或 `artifacts/` 下的本地生成文件。
- 依赖或锁文件变化必须与对应源文件一起提交。

## 版本与发布

发布由维护者执行。版本号必须在以下文件中保持一致：

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

更新版本与 `CHANGELOG.md` 后，`npm run version:check` 必须通过。推送 `vX.Y.Z` 标签会启动 Windows 正式 Release，构建并发布同版本 NSIS 安装包；macOS 仅保留源码、CI 与 ad-hoc 构建验证，不作为正式 Release 资产。贡献者不要在普通 PR 中创建或推送标签。
