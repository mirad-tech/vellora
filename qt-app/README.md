# Vellora 桌面实现

`qt-app` 使用 Qt 6 Widgets，通过 `bridge` 调用 Rust `md` 与 `core`。不使用 WebView。

## 构建与回归

从项目根目录运行，需已有官方 Qt 6.8.3 MSVC2022 x64 kit（含 Qt Image Formats）、Rust MSVC、VS C++ Build Tools、Windows SDK：

```powershell
./qt-app/build.ps1 -Test -EmitLegacyOutput:$false -CargoTargetDir ./target/cargo-current
```

Qt kit 优先使用 `-QtRoot` 或 `QT_ROOT`；未指定时使用 `qt/6.8.3/msvc2022_64`。可指定 `-QtRoot`、`-MsvcRoot`、`-WindowsSdkRoot`、`-BuildRoot` 和 `-CargoTargetDir`。脚本先用 Cargo 构建 Rust 桥接库，再用 qmake/nmake 构建 Qt；不安装本机工具。默认输出 `target/qt-release/app/vellora.exe`。

`-Test` 运行 Rust core/md/bridge 与多组 Qt 离屏回归，并构建独立 `test-app`。生产 `app` 不启用 `VELLORA_ENABLE_TEST_HOOKS`；不要分发诊断程序或用它的哈希代表用户运行版。`-EmitLegacyOutput:$false` 避免额外复制到源码目录。

[测试细节](tests/README.md) 中的离屏结果不代替真实 OS 输入法、窗口交互、DPI 或安装验收。涉及保存和冲突时使用文档副本，保护原文与用户正在使用的窗口。

## 运行与打包

便携版入口为构建产物中的 `Vellora-0.1.2-portable/vellora.exe`，整目录须保留。应用接受 Markdown 文件路径以及 `--source` / `--source-mode`；同用户已有实例时，打开请求可能送到该实例，不要在用户编辑期间用它做隔离测试。

`installer/package-qt.ps1` 生成新便携目录和 NSIS 安装包，不安装、不改关联；使用新输出目录，保留完整运行库、插件与许可证。当前代码和打包默认版本为 0.1.2。依赖、命令、产物和升级规则见[打包与安装说明](../installer/README.md)。

## 实现与安全边界

- MainWindow 管理保存基线与草稿；关闭、切文件、切模式前收集待处理编辑。
- Rust 负责 Markdown 解析、段落映射及编辑拼接。正文编辑由 DocumentView 序列化变更片段，再通过 `vellora_splice_text` / `md::splice_markdown` 拼回原文；未改动片段保留原始字节。Rust AST 导出器 `md/src/export.rs` 是独立路径，语法规则须与 Qt 序列化保持一致。
- DocumentView 使用 QTextDocument 显示与编辑，Markdown 原文、图片、源码片段预览和搜索高亮分开维护。
- SourceView 是源码文本编辑。显示层中文首行缩进不能向保存内容添加空格，已有缩进不应重复。
- 原始 HTML/Markdown 片段的原文与预览分离；不执行脚本、事件处理器和任意 CSS。
- 文件、图片和链接访问由 core 校验；使用同一已验证文件句柄读取的图片字节，编码文件上限 10 MiB，缓存和动画有界。
- HTTP(S) 外链需确认，本地资源不能越过当前文档允许目录。复制正文可包含 HTML 与纯文本，粘贴按纯文本处理。
