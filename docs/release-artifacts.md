# 本地发布产物管理

本项目只使用 Tauri 2 生成 Windows NSIS 安装包。GitHub Releases 是对外发布源，
本地 `artifacts/releases/` 用于在开发机上区分当前安装包与历史安装包。

## 目录职责

```text
artifacts/releases/
├─ current/           当前 `package.json` 版本，只允许一个安装包
├─ archive/
│  ├─ tauri/          历史 Tauri 安装包
│  └─ electron/       迁移保留的 Electron 1.x 安装器与更新元数据
└─ manifest.json      当前与归档文件的大小、SHA-256
```

- `artifacts/releases/` 是本地生成目录，已加入 `.gitignore`，不提交二进制文件。
- `src-tauri/target/release/` 是 Cargo/Tauri 可重建的编译缓存，不作为发布归档。
- 根目录旧 `release/` 属于已移除的 Electron 构建流程，不应重新创建或使用。
- `dist/` 是 Vite 前端构建结果，不是桌面安装包。

## 命令

```powershell
npm run build              # 构建原始 NSIS 安装包
npm run release:organize   # 整理当前安装包、归档旧 Tauri 安装包并更新清单
npm run release:check      # 校验当前版本、文件数量和 SHA-256
npm run release:clean-cache # 删除可重建的 Tauri release 编译缓存
npm run dist               # 依次执行 build 与 release:organize
```

`release:organize` 不删除历史安装器。同名同哈希的重复文件会去重；同名但内容
不同的构建会追加哈希前缀后归档，避免静默覆盖。
