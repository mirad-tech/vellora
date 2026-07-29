# 本地发布产物管理

本项目只使用 Tauri 2 生成 Windows NSIS 安装包。GitHub Releases 是对外发布源，
本地 `artifacts/releases/` 只保留当前安装包；历史正式版本由 GitHub Releases 保留。

## 目录职责

```text
artifacts/releases/
├─ current/           当前 `package.json` 版本，只允许一个安装包
└─ manifest.json      当前安装包的版本、大小与 SHA-256
```

- `artifacts/releases/` 是本地生成目录，已加入 `.gitignore`，不提交二进制文件。
- 历史安装器不在开发机重复归档；需要时从 GitHub Releases 获取。
- `src-tauri/target/release/` 是 Cargo/Tauri 可重建的编译缓存，不作为发布归档。
- 根目录旧 `release/` 属于已移除的 Electron 构建流程，不应重新创建或使用。
- `dist/` 是 Vite 前端构建结果，不是桌面安装包。

## 命令

```powershell
npm run build              # 构建原始 NSIS 安装包
npm run release:organize   # 复制当前安装包、删除本地旧版并更新清单
npm run release:check      # 校验当前版本、文件数量和 SHA-256
npm run release:prune-old  # 无需重新构建，删除遗留本地旧版并更新清单
npm run release:clean-cache # 删除可重建的 Tauri release 编译缓存
npm run dist               # 依次执行 build 与 release:organize
```

`release:organize` 会以最新构建覆盖同版本本地副本，并删除本地旧版。对外发布与
历史追溯仍以 GitHub Releases 为准。
