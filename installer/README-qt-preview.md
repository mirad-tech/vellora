# Vellora 0.1.1 安装包

当前工作区根目录已是 Rust workspace，无需再加 native/ 前缀。

    ./installer/package-qt.ps1 -Version 0.1.1

需已有 Qt 6.8.3 MSVC2022 x64（含 Qt Image Formats）、Rust MSVC、VS C++ Build Tools、Windows SDK 和 NSIS。脚本不安装这些依赖，也不执行安装器、不改注册表和默认应用、不发布软件。

默认运行构建与回归。使用新的输出目录，产出：
- Vellora-0.1.1-portable/，运行 vellora.exe。
- Vellora-Setup-0.1.1.exe。
- manifest.json，含实际版本、文件大小和 SHA-256。

打包同时检查应用与安装器的 Windows 版本资源，不能仅靠文件名改版本。RunTests=false 仅适合已在同一源码上完成独立测试的构建，不代表测试通过。

## 用户自行安装后的行为

安装器显示名称、开始菜单和桌面入口均为 Vellora。默认安装到当前用户的 %LOCALAPPDATA%\Programs\Vellora，不需管理员权限，登记正常卸载入口。不设置默认 Markdown 关联、不自启动、不自动打开程序。

- 不覆盖未标记的非空目录、其他版本或旧软件登记和入口。
- 仅允许本安装器标记的同版本原目录重新安装；其他版本（包括更高版本）应先正常卸载或另行处理，不自动降级。
- 安装及卸载前检查目标程序文件是否可独占打开；无法替换时要求先保存并关闭程序。
- 卸载只删除包内明列文件，保留目录中额外的用户文件，不清除应用用户数据。
- 静态检查、编译及便携启动不等同于实际安装、覆盖安装、卸载验收。未执行的项目应单独说明。

## 技术依赖与许可证

内部仍使用 Qt，运行库文件名及第三方许可证保持原样，不改名隐藏依赖。官方 windeployqt 收集运行库和插件；MSVC CRT 采用应用本地部署；保留 Qt 模块对应 SPDX SBOM、许可证、版权及源码链接。产品品牌不包含技术后缀，许可证中技术名称不能删除。

便携运行验证：

    ./qt-app/tests/smoke-portable.ps1 -PortableDir '输出目录/Vellora-0.1.1-portable' -OutputDir '新测试目录'

该验证先拒绝已有生产实例，使用仅系统 PATH 检查应用本地 DLL 与平台插件，并确认生产版不启用测试钩子。它不运行安装器，也不代替实屏、真实输入法或其他 Windows 版本验证。
## 可选 Markdown 关联

安装器在目录页之后提供默认不勾选的选项，范围仅为 `.md` 和 `.markdown`。选中时在当前用户下注册 Vellora 的 ProgID、打开命令、图标、OpenWithProgids、RegisteredApplications 和 Capabilities；安装成功后打开 Windows 默认应用设置。取消勾选不撤销也不修改既有文件关联。

注册“打开方式”候选并不等于强行成为默认应用。安装器不写扩展默认值，不写、删除或伪造受保护的 UserChoice。已有其他程序的默认选择由 Windows 保留。若同名 Vellora 注册指向其他位置，安装器保留它并提示冲突，不通过复用 ProgID 偷换打开目标。

卸载仅在注册的安装路径与命令仍属于本安装时移除该 ProgID/OpenWith 候选，在 Capabilities 所有者仍匹配时移除相应登记；不清理应用用户设置，不修改其他程序的登记或受保护默认选择。

静态策略测试（不会安装或修改注册表）：

    python installer/tests/test_association_policy.py

真实安装界面、默认应用设置跳转和实际文件打开仍需单独验收；静态策略及 NSIS 编译不能替代它们。
