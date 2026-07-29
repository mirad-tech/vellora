# 历史文件

此目录保留迁移期旧实现用于审计，不参与 `package.json`、Tauri 配置、GitHub Actions
或正式发布流程。

- `electron-builder/`：迁移到 Tauri 前的 Electron 打包与 NSIS 文件；当前依赖中
  已无 Electron、electron-builder 或 resedit，不能作为现行构建入口。
- `wdio-browser/`：已由 `tests/e2e/smoke.mjs` 的 Edge + Puppeteer 流程替代；
  不属于 CI 支持的测试命令。

新功能和修复不得继续引用此目录；确认不再需要迁移追溯后应整体删除对应子目录。
