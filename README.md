# Vellora

Windows Markdown 阅读与编辑器。

## 功能

- 阅读渲染后的 Markdown，并直接编辑正文；也可切换到源码模式。
- 目录导航、搜索替换、撤销重做和文件保存。
- 支持标题、引用、有序与无序列表、任务列表、表格、图片和代码块。
- 支持中文输入、中文正文首行缩进、主题与字体设置。

## 下载与安装

[下载 Vellora 0.1.1](https://github.com/mirad-tech/vellora/releases/download/v0.1.1/Vellora-Setup-0.1.1.exe) · [版本发布页](https://github.com/mirad-tech/vellora/releases/tag/v0.1.1)

适用于 Windows 10/11 x64。运行安装包并按向导安装。可选注册 `.md`、`.markdown` 文件关联；默认打开方式由 Windows 的默认应用设置确认，不强制覆盖现有选择。

安装包 SHA256：

```text
C5F5E81FF193F61A4C1DAD67FAFB3AAE3B2A4A6A9FAF34B97F765E78FFBFDCED
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
