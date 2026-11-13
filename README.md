# Vellora

Windows Markdown 阅读与编辑器。

## 功能

- 阅读渲染后的 Markdown，并直接编辑正文；也可切换到源码模式。
- 目录导航、搜索替换、撤销重做和文件保存。
- 支持标题、引用、有序与无序列表、任务列表、表格、图片和代码块。
- 支持中文输入、中文正文首行缩进、主题与字体设置。

## 下载与安装

适用于 **Windows 10 / 11 x64（64 位）**。普通用户下载安装包即可，无需安装开发工具或自行编译。

[直接下载安装包：Vellora-Setup-0.1.2.exe](https://github.com/mirad-tech/vellora/releases/download/v0.1.2/Vellora-Setup-0.1.2.exe) · [打开版本发布页](https://github.com/mirad-tech/vellora/releases/tag/v0.1.2)

### 1. 下载安装包

1. 打开上方的 **版本发布页**。
2. 在页面下方找到 **Assets（资源）**，如果已折叠，点击展开。
3. 点击 **`Vellora-Setup-0.1.2.exe`**，等待下载完成。也可以使用上方的直达下载链接。
4. 不要选择 `Source code (zip)` 或 `Source code (tar.gz)`：它们是源码，不是可直接安装的软件。

### 2. 安装 Vellora

1. 如果 Vellora 正在运行，先保存文档并关闭窗口。
2. 双击下载的 `Vellora-Setup-0.1.2.exe`。
3. 按安装向导继续，阅读许可条款并确认同意后，选择安装位置。默认安装到当前用户的 `%LOCALAPPDATA%\Programs\Vellora`，通常保留默认位置即可。
4. 在 **Markdown 文件关联** 页面按需选择：
   - **不勾选**：保持当前文件关联不变，之后仍可在 Vellora 内通过“打开”选择文档。
   - **勾选“将 Vellora 添加到 Markdown 打开方式，并打开默认应用设置”**：安装后会打开 Windows 设置，供你选择默认打开方式。勾选本身不会强行替换现有默认应用。
5. 点击 **安装**，等待完成，再点击 **完成**。
6. 从桌面快捷方式或开始菜单打开 **Vellora**，点击 **打开**，选择一个 `.md` 或 `.markdown` 文件开始使用。

### 3. 可选：设为 Markdown 默认打开方式

如果安装时勾选了文件关联选项，在打开的 **Windows 设置 → 应用 → 默认应用** 中，为 `.md` 和 `.markdown` 分别选择 **Vellora**：

- **Windows 11**：搜索文件扩展名（例如 `.md`），选择 Vellora 并确认，然后对 `.markdown` 重复一次。
- **Windows 10**：进入“按文件类型指定默认应用”，找到这两个扩展名并分别选择 Vellora。

也可以右键一个 Markdown 文件，选择 **打开方式 → 选择其他应用**，选择 Vellora，再按系统提示确认始终使用它。不同 Windows 版本的按钮文字可能略有不同。

### 安全提示与下载校验

当前 0.1.2 安装包**尚未进行数字签名**，Windows 可能显示“Windows 已保护你的电脑”或未知发布者提示。这不等于已经通过安全认证。请只从本仓库的 Release 下载，并在确认来源、文件名及下方校验值一致且愿意继续后，才选择 **更多信息 → 仍要运行**（如果系统提供该选项）。

不要关闭杀毒软件或 SmartScreen。如果文件校验不一致、出现明确的恶意软件警报，或设备受组织策略限制，请停止安装，不要强行绕过。

安装包 SHA256：

```text
9960A1A4E47DAC92485CB4740B74F16193E544E17C18BA0550D5C60B06650C3D
```

可选校验方法：在下载文件所在文件夹打开 PowerShell，运行下方命令，将输出的 Hash 与上方值比较：

```powershell
Get-FileHash -Algorithm SHA256 .\Vellora-Setup-0.1.2.exe
```

## 构建

界面使用 Qt Widgets，Markdown 与文件处理使用 Rust，通过静态桥接连接。

需要 Rust MSVC 工具链、Visual Studio C++ x64 Build Tools、Windows SDK，以及 Qt 6.8.3 MSVC2022 x64（qtbase、qtsvg、qtimageformats）。在仓库根目录的 PowerShell 中运行：

```powershell
.\qt-app\build.ps1 -QtRoot 'C:\Qt\6.8.3\msvc2022_64' -Test -EmitLegacyOutput $false
```

请将 Qt 路径替换为自己的安装位置。产物位于 `target\qt-release\app\vellora.exe`，运行需要对应 Qt 动态库。`-Test` 会运行 Rust 与 Qt 自动化测试。

打包脚本为 `installer\package-qt.ps1`，另需官方 NSIS，并通过 `-MakeNsis` 指定 `makensis.exe`；Qt 安装须保留上述模块的 SBOM。脚本会生成携带运行依赖的便携目录和安装包，不自动安装。

## 许可证

项目使用 [MIT 许可证](LICENSE)。Qt 与其他第三方组件遵循各自许可证，相关声明随安装包提供。
