# Vellora

中文 | [English](README.en.md)

Markdown 阅读与编辑器，支持 Windows 和 Linux。

## 功能

- 阅读渲染后的 Markdown，并直接编辑正文；也可切换到源码模式。
- 侧边栏：文件树和大纲在同一栏切换（`Ctrl+\`）。可打开文件夹、新建文件，按 `F2` 直接重命名，按 `Delete` 删除到回收站，拖动文件或文件夹到另一个文件夹即可移动；重命名或移动正在编辑的文档不会打断编辑。
- 搜索替换、撤销重做和文件保存；切换文件时可选择“保存并切换”。
- 支持标题、引用、有序与无序列表、任务列表、表格、图片和代码块。
- 支持中文输入、中文正文首行缩进；浅色与深色主题跟随系统设置。
- 界面语言跟随系统：系统界面语言是中文（简体或繁体）时显示简体中文界面，其他语言显示英文界面。安装程序同样按 Windows 显示语言选择中文或英文。
- 提供便携版：解压即用，设置保存在程序文件夹中。

## 下载与安装

Windows 版适用于 **Windows 10 / 11 x64（64 位）**，Linux 版见下方 [Linux](#linux-版)。普通用户下载安装包即可，无需安装开发工具或自行编译。

[打开最新版本发布页](https://github.com/mirad-tech/vellora/releases/latest)

### 1. 下载安装包

1. 打开上方的 **最新版本发布页**。
2. 在页面下方找到 **Assets（资源）**，如果已折叠，点击展开。
3. 点击 **`Vellora-Setup-版本号.exe`**（例如 `Vellora-Setup-0.1.8.exe`），等待下载完成。
4. 不要选择 `Source code (zip)` 或 `Source code (tar.gz)`：它们是源码，不是可直接安装的软件。

### 2. 安装 Vellora

1. 如果 Vellora 正在运行，先保存文档并关闭窗口。
2. 双击下载的安装包。已安装旧版本时会在原位置升级。
3. 按安装向导继续，阅读许可条款并确认同意后，选择安装位置。默认安装到当前用户的 `%LOCALAPPDATA%\Programs\Vellora`，通常保留默认位置即可。
4. 在 **Markdown 文件关联** 页面按需选择：
   - **不勾选**：保持当前文件关联不变，之后仍可在 Vellora 内通过“打开”选择文档。
   - **勾选“将 Vellora 添加到 Markdown 打开方式，并打开默认应用设置”**：安装后会打开 Windows 设置，供你选择默认打开方式。勾选本身不会强行替换现有默认应用。
5. 点击 **安装**，等待完成，再点击 **完成**。
6. 从桌面快捷方式或开始菜单打开 **Vellora**，点击 **打开**，选择一个 `.md` 或 `.markdown` 文件开始使用。

### 便携版

不想安装、没有安装权限，或想放在 U 盘里使用时，可以下载 `Vellora-版本号-portable-x64.zip`：

1. 把整个压缩包解压到任意文件夹，例如 `D:\Tools\Vellora` 或 U 盘。
2. 双击里面的 `vellora.exe`。不需要安装，也不需要管理员权限；不要只拷出 `vellora.exe`，它需要同一文件夹里的其他文件。
3. 不再使用时，删除整个文件夹即可。

便携版文件夹里有 `portable.txt`，窗口大小、侧边栏打开的文件夹等设置因此保存在同一文件夹的 `Vellora.ini` 中，不写入注册表。文件夹不能写入时（例如放在 Program Files 下），设置改存到注册表 `HKEY_CURRENT_USER\Software\Vellora Contributors\Vellora`。便携版不注册文件关联，也不创建快捷方式。

### 3. 可选：设为 Markdown 默认打开方式

如果安装时勾选了文件关联选项，在打开的 **Windows 设置 → 应用 → 默认应用** 中，为 `.md` 和 `.markdown` 分别选择 **Vellora**：

- **Windows 11**：搜索文件扩展名（例如 `.md`），选择 Vellora 并确认，然后对 `.markdown` 重复一次。
- **Windows 10**：进入“按文件类型指定默认应用”，找到这两个扩展名并分别选择 Vellora。

也可以右键一个 Markdown 文件，选择 **打开方式 → 选择其他应用**，选择 Vellora，再按系统提示确认始终使用它。不同 Windows 版本的按钮文字可能略有不同。

### 安全提示与下载校验

安装包和便携版**尚未进行数字签名**，Windows 可能显示“Windows 已保护你的电脑”或未知发布者提示。这不等于已经通过安全认证。请只从本仓库的 Release 下载，并在确认来源、文件名及发布页上的校验值一致且愿意继续后，才选择 **更多信息 → 仍要运行**（如果系统提供该选项）。

不要关闭杀毒软件或 SmartScreen。如果文件校验不一致、出现明确的恶意软件警报，或设备受组织策略限制，请停止安装，不要强行绕过。

可选校验方法：在下载文件所在文件夹打开 PowerShell，运行下方命令，将输出的 Hash 与发布页“下载校验”中的值比较：

```powershell
Get-FileHash -Algorithm SHA256 .\Vellora-Setup-*.exe
Get-FileHash -Algorithm SHA256 .\Vellora-*-portable-x64.zip
```

### Linux 版

在最新版本发布页的 **Assets（资源）** 中按电脑架构下载 AppImage：

- `Vellora-版本号-x86_64.AppImage`：x86_64 电脑，需要 glibc 2.35 及以上（如 Ubuntu 22.04、Debian 12 及更新版本）。
- `Vellora-版本号-aarch64.AppImage`：ARM64 电脑，需要 glibc 2.39 及以上（如 Ubuntu 24.04、Debian 13 及更新版本）。

下载后加上可执行权限再运行，例如：

```sh
chmod +x Vellora-*-x86_64.AppImage
./Vellora-*-x86_64.AppImage
```

校验方法：运行 `sha256sum Vellora-*.AppImage`，将输出与发布页“下载校验”中的值比较。

## 构建

界面使用 Qt Widgets，Markdown 与文件处理使用 Rust，通过静态桥接连接。

需要 Rust MSVC 工具链、Visual Studio C++ x64 Build Tools、Windows SDK，以及 Qt 6.8.3 MSVC2022 x64（qtbase、qtsvg、qtimageformats）。在仓库根目录的 PowerShell 中运行：

```powershell
.\qt-app\build.ps1 -QtRoot 'C:\Qt\6.8.3\msvc2022_64' -Test -EmitLegacyOutput $false
```

请将 Qt 路径替换为自己的安装位置。产物位于 `target\qt-release\app\vellora.exe`，运行需要对应 Qt 动态库。`-Test` 会运行 Rust 与 Qt 自动化测试。

打包脚本为 `installer\package-qt.ps1`，另需官方 NSIS，并通过 `-MakeNsis` 指定 `makensis.exe`；Qt 安装须保留上述模块的 SBOM。脚本会生成携带运行依赖的便携目录、安装包和便携版 zip，不自动安装。具体命令、产物及升级规则见[打包与安装说明](installer/README.md)。

### Linux

需要 Rust（stable，`rustup` 或发行版自带 cargo 均可）、C++17 编译器、`make`，以及 Qt 6（qtbase、qtsvg；建议 6.8 LTS，发行版自带的 Qt 6.8 也可）。以 Debian / Ubuntu 为例：

```sh
sudo apt install build-essential qt6-base-dev qt6-base-dev-tools qt6-svg-dev qmake6
./qt-app/build.sh --test
```

脚本优先使用 PATH 中的 `qmake6`，也可用 `QMAKE=/path/to/qt/bin/qmake` 指定其他 Qt。产物位于 `target/qt-release/app/vellora`；`--test` 会在无界面（offscreen）模式下运行 Rust 与 Qt 自动化测试，`--debug`、`--clean` 与 Windows 脚本含义相同。

安装到系统（含 `.desktop` 启动项、`text/markdown` 关联与图标）：

```sh
PREFIX=/usr/local ./qt-app/build.sh
sudo make -C target/qt-release/app install
sudo update-desktop-database; sudo update-mime-database /usr/local/share/mime
```

打包 AppImage（自动下载 linuxdeploy 及其 Qt 插件，无需 FUSE）：

```sh
./installer/linux/package-appimage.sh            # 产物在 target/appimage/
```

AppImage 只能在 glibc 不低于构建机的发行版上运行；CI 用 Qt 6.8.3 构建，x86_64 在 Ubuntu 22.04 上、aarch64 在 Ubuntu 24.04 上，并上传两个 AppImage 作为构建产物。

## 许可证

项目使用 [MIT 许可证](LICENSE)。Qt 与其他第三方组件遵循各自许可证，相关声明随安装包提供。
