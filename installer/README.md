# 安装与卸载（Vellora Native Preview 0.1.0）

## 产物

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `native/installer/out/VelloraNative-Setup-0.1.0.exe` | 419,006 B | `AC41C2037C9CBF282EC7935FDE1FF08E5FA82194923A7807C0B49C9C46573292` |
| `native/target/release/vellora-native.exe` | 678,400 B | `24ECC505D3D491F918DE2091052A1BBCE8843577C5805B93CB7BA12F3463FE6C` |

重新构建：

```powershell
pwsh -File native/installer/build-installer.ps1 -Version 0.1.0
```

脚本会 `cargo build --release`、调用 NSIS（优先使用 `%LOCALAPPDATA%\tauri\NSIS\makensis.exe`），并生成同名 `.json` 清单（含两个哈希与 rustc 版本）。

## 安装位置与影响范围

- 安装目录：`%LOCALAPPDATA%\Programs\VelloraNative`（当前用户，无需管理员）。
- 开始菜单：`Vellora Native`（程序 + 卸载）；桌面快捷方式。
- 注册表：`HKCU\Software\VelloraNative` 与 `HKCU\...\Uninstall\VelloraNative`（仅用于“应用和功能”条目）。
- **不写 `.md` 文件关联**：旧版 Vellora 仍是默认程序。切换关联需要在用户批准后单独处理。

## 已验证

在 `%TEMP%\VelloraNativeInstallTest` 上做了完整的静默安装/运行/卸载验证：

| 步骤 | 结果 |
|---|---|
| `/S /D=<临时目录>` 静默安装 | 退出码 0 |
| 安装内容 | `vellora-native.exe`、`uninstall.exe`、`README.txt`、`LICENSE.txt` |
| 注册表条目 | DisplayName `Vellora Native (Preview)`、DisplayVersion `0.1.0`、UninstallString 指向安装目录 |
| 快捷方式 | 开始菜单与桌面均已创建 |
| 从安装目录启动并打开文档 | 进程存活，标题 `06-ui-polish.md — Vellora` |
| 静默卸载 | 退出码 0 |
| 卸载后 | 安装目录、开始菜单项、桌面快捷方式、注册表键全部消失 |

## 未验证

- 覆盖安装（升级）与降级。
- 多用户机器上的行为。
- 签名（当前未签名，Windows 可能提示“未知发布者”）。
- 文件关联注册（按计划有意不做）。

## 从旧版迁移

两者可以并存：旧版继续使用自己的安装目录与关联。要试用原生版，安装后从开始菜单启动，或把文件拖到窗口里。确认不再需要旧版之前，不要删除旧安装。
