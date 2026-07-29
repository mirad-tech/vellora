# 安全策略

## 支持范围

Vellora 目前只维护最新 GitHub Release。发现问题后，请先确认所用版本是否为 [最新版本](https://github.com/mirad-tech/vellora/releases/latest)。旧版本通常通过升级到当前版本获得修复。

## 私下报告漏洞

请不要通过公开 Issue、Pull Request、讨论区或日志附件披露未修复漏洞。

使用仓库的 [私密漏洞报告](https://github.com/mirad-tech/vellora/security/advisories/new) 提交以下信息：

- 受影响版本与 Windows 版本
- 最小复现步骤或概念验证
- 实际影响与可利用条件
- 已知缓解方式
- 是否已经向其他人披露

不要附带真实私密 Markdown 文档、凭据或个人信息；请使用最小脱敏样本。

## 重点安全边界

以下行为属于高优先级安全问题：

- 绕过 `.md` / `.markdown` 扩展限制读取或写入其他文件
- 通过相对路径、符号链接或编码变体逃逸当前文档目录
- 绕过 10 MiB 图片上限或加载目录外本地图片
- 未经确认打开外链，或接受 `javascript:`、`data:`、`file:`、`vbscript:` 等协议
- 获得通用文件系统、Shell、任意 URL 或不必要的 Tauri capability
- 未保存更改在关闭或切换文档时静默丢失

## 处理原则

维护者会先确认报告是否可复现、影响范围和修复优先级。修复发布前，请避免公开细节或利用代码。处理时间取决于严重度与复现完整度；本项目不承诺固定响应时限。

修复完成后，可在征得报告者同意的情况下于 GitHub Security Advisory 或 Release Notes 中致谢。
