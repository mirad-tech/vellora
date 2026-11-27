# Vellora 构建、打包与安装

当前发行入口为 [package-qt.ps1](package-qt.ps1)，安装行为由 [vellora-qt-preview.nsi](vellora-qt-preview.nsi) 定义。当前代码和打包默认版本为 **0.1.8**。

## 构建与产物

需要已有 Rust MSVC 工具链、Visual Studio C++ x64 Build Tools、Windows SDK、Qt 6.8.3 MSVC2022 x64（qtbase、qtsvg、qtimageformats）和官方 NSIS。Qt 安装须保留这三个模块的 `sbom/*.spdx.json`。

在仓库根目录的 PowerShell 中运行，按实际安装位置调整路径：

```powershell
./installer/package-qt.ps1 -QtRoot 'C:\Qt\6.8.3\msvc2022_64' -MakeNsis 'C:\Program Files (x86)\NSIS\makensis.exe'
```

脚本先调用 `qt-app/build.ps1` 构建 Rust 桥接库和 Qt 应用，默认运行 Rust 与 Qt 离屏回归。`-RunTests $false` 可跳过回归测试。构建和回归入口详见 [Qt 开发说明](../qt-app/README.md) 与 [测试说明](../qt-app/tests/README.md)。

- `-QtRoot` 默认读取 `QT_ROOT`，未设置时使用仓库内的 `qt/6.8.3/msvc2022_64`。
- `-BuildRoot` 默认是 `target/qt-release`；可通过 `-CargoTargetDir`、`-MsvcRoot`、`-WindowsSdkRoot` 指定工具链和构建路径。
- `-OutputDir` 默认是新建的 `target/qt-package-yyyyMMdd-HHmmss`。指定的输出目录必须不存在，脚本拒绝覆盖已有目录。
- `-MakeNsis` 未指定时查找 `%LOCALAPPDATA%\tauri\NSIS\makensis.exe`；脚本不会下载或安装工具。

输出目录包含：

| 产物 | 内容 |
|---|---|
| `Vellora-0.1.8-portable/` | `vellora.exe`、Qt/MSVC 运行库、插件、许可证和用户说明 `README.txt`；安装包由它生成，不含 `portable.txt` |
| `Vellora-Setup-0.1.8.exe` | 当前用户范围的 NSIS 安装包 |
| `Vellora-0.1.8-portable-x64.zip` | 便携版：上面的目录另加 `portable.txt`，压缩后顶层为 `Vellora-0.1.8-portable/` |
| `manifest.json` | 实际版本、文件路径、大小、SHA256（含安装包和便携版 zip），以及生产构建标记 |
| `uninstall-files.nsh` | 从本次便携目录生成的卸载文件清单 |

打包只使用 `<BuildRoot>/app/vellora.exe`，不包含启用测试钩子的 `test-app`。脚本检查应用和安装器的 Windows 版本资源；`-Version` 必须与代码版本一致，不能只改包名。Qt 运行依赖通过 `windeployqt` 收集，MSVC CRT 随应用部署；`licenses/` 保留许可证、Qt 模块 SBOM、版权及源码链接。

脚本生成安装包，不执行安装器，也不发布软件。

## 便携模式

`vellora.exe` 所在文件夹有 `portable.txt` 时，应用把设置写入同一文件夹的 `Vellora.ini`，不读写注册表。侧边栏打开的文件夹同时记下绝对路径和相对程序文件夹的路径（同一盘上时），U 盘换盘符或程序在同盘移动后都能恢复。该文件夹不能写入时，应用改用注册表 `HKCU\Software\Vellora Contributors\Vellora`。

安装包与卸载清单在加入 `portable.txt` 之前由 `Vellora-<版本>-portable/` 生成；`portable.txt` 只复制到另一份临时目录并压缩为 zip。脚本在压缩前确认安装包来源目录中没有该文件，压缩后核对条目数，`test_release_policy.py` 也检查这一顺序。用户说明 `README.txt` 来自 `assets/README-dist.txt`，安装版与便携版相同。

## 安装与升级行为

- 默认安装到 `%LOCALAPPDATA%\Programs\Vellora`，无需管理员权限；创建 Vellora 开始菜单、桌面快捷方式和卸载入口，不设置开机自启动，也不自动启动应用。
- 安装器拒绝未标记的非空目标目录，以及其他位置的 Vellora 安装登记或不归本安装管理的已有入口。
- 带有相同安装器标记的目录允许同版本修复安装。当前 0.1.8 还允许从 0.1.0/0.1.1/0.1.2/0.1.3/0.1.4/0.1.5/0.1.6/0.1.7 原目录升级，但要求安装标记匹配，且注册的安装路径等于目标目录；其他版本不在此升级范围内。
- 安装和卸载前检查程序文件是否可独占打开；无法替换时要求先保存文档并关闭程序。
- 卸载按本次包内清单删除文件，保留额外用户文件；仅当登记的安装路径仍属于本安装时清理快捷方式、卸载登记及所属文件关联，不清理应用用户设置。

## 可选 Markdown 关联

安装器在目录页之后提供默认不勾选的关联选项，范围仅为 `.md` 和 `.markdown`。选中时，在当前用户下注册 Vellora 的 ProgID、打开命令、图标、OpenWithProgids、RegisteredApplications 和 Capabilities；注册成功后打开 Windows 默认应用设置，由用户选择默认程序。未勾选时保持既有文件关联。

安装器不写扩展默认值或受保护的 UserChoice。若同名 Vellora 注册指向其他位置，安装器保留它并提示冲突。卸载仅移除所有权与打开命令符合本安装的 ProgID/OpenWith 候选，以及所有权匹配的 Capabilities 登记。

## 验证入口

以下静态策略检查读取安装脚本，不执行安装或修改注册表。`test_release_policy.py` 已包含在 `tools/check.ps1` 中（需要 Python 3.11 或更新版本）：

```powershell
python installer/tests/test_association_policy.py
python installer/tests/test_release_policy.py
```

便携运行验证会启动本次便携目录中的应用，单独执行：

```powershell
./qt-app/tests/smoke-portable.ps1 -PortableDir '输出目录/Vellora-0.1.8-portable' -OutputDir '新测试目录'
```

该脚本拒绝连接已有生产实例，使用仅含系统目录的 PATH 检查应用本地 DLL 和平台插件，并检查生产版未启用测试钩子。它不运行安装器；真实安装、升级、卸载、文件关联和 Windows 输入法体验需分别验收。

## 历史入口

旧 Win32/Rich Edit 实现、实验目录和预览版安装流程仅保留在本地，由 `.gitignore` 排除，不参与当前 `package-qt.ps1` 发行流程。当前便携版的 `README.txt` 由打包脚本从 `assets/README-dist.txt` 生成。
