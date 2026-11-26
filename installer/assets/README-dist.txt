Vellora {VERSION}（Windows 10 / 11 x64）

运行
- 安装版：从开始菜单或桌面快捷方式启动。
- 便携版：解压整个文件夹，双击 vellora.exe。不要只拷出 vellora.exe，它需要同一文件夹里的其他文件。

设置保存在哪里
- 文件夹里有 portable.txt 时（便携版自带），窗口大小、侧边栏打开的文件夹等设置保存在同一文件夹的 Vellora.ini 里，不写入注册表，可以随文件夹带到别的电脑。
- 侧边栏打开的文件夹如果和程序在同一个盘，会按相对位置记住；U 盘换了盘符也能找到。
- 如果这个文件夹不能写入（例如放在 Program Files 下，或 U 盘开了写保护），设置改为保存在注册表：
  HKEY_CURRENT_USER\Software\Vellora Contributors\Vellora
- 没有 portable.txt 时（安装版），设置保存在上面的注册表位置。
- 便携版不注册文件关联，也不创建快捷方式；不再使用时删除整个文件夹即可。

安全提示
程序尚未进行数字签名，Windows 可能提示“未知发布者”。请只从 https://github.com/mirad-tech/vellora/releases 下载。

许可
Vellora 以 MIT 许可证发布。本程序以动态链接方式使用 Qt {QT_VERSION}，可按相应许可证替换为兼容版本；Microsoft VC 运行库随程序附带。许可证全文和源码链接见 licenses 文件夹。
