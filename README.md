# Markdown查看器 / Markdown viewer

Markdown查看器 是一个本地优先的 Electron Markdown 文档查看器，英文名为 Markdown viewer。

## 使用

- 打开 Markdown 文件：选择 `.md` 或 `.markdown` 文件并阅读。
- 打开文件夹：浏览文件夹内的 Markdown 文件树，并可筛选文件。
- 搜索：在当前文档内搜索并跳转上一个/下一个结果。
- 大纲：按 H1-H6 标题导航长文档。
- 本地资源：相对路径图片会在本地解析，缺失图片会显示占位。
- 编辑：可切换到源码编辑 + 预览分屏，保存前会提示未保存状态。
- 默认编辑器：可用系统默认编辑器打开当前 Markdown 文件。

## 打包版说明

Windows 版本使用 NSIS 安装包。安装时可选择安装路径，并可勾选是否关联 .md 和 `.markdown` 文件。

应用只通过受控文件 API 打开、读取和保存用户选择的 Markdown 文档。卸载或删除应用本身不会删除用户文档。
