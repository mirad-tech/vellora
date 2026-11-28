# 安全政策 / Security Policy

## 支持的版本 / Supported versions

只有最新发布的版本会收到安全修复。请先升级到[最新版本](https://github.com/mirad-tech/vellora/releases/latest)再确认问题是否仍然存在。

Only the latest release receives security fixes. Please check whether the issue still occurs on the [latest release](https://github.com/mirad-tech/vellora/releases/latest).

## 报告漏洞 / Reporting a vulnerability

请**不要**公开提 Issue。在本仓库的 **Security（安全）** 标签页点击 **Report a vulnerability（报告漏洞）** 私下提交，写明：

- 受影响的版本和系统；
- 复现步骤或示例文件（例如能触发问题的 Markdown 或图片）；
- 可能的影响。

维护者会尽快回复，修复后在发布说明中致谢（如你愿意）。

Please **do not** open a public issue. Use **Report a vulnerability** under this repository's **Security** tab to report privately, and include the affected version and OS, steps or a sample file to reproduce (for example a Markdown file or image that triggers it), and the likely impact. The maintainer will reply as soon as possible and, if you wish, credit you in the release notes once it is fixed.

## 说明 / Notes

- 安装包和便携版目前未做数字签名，请只从本仓库的 Releases 下载并核对发布页上的 SHA256。
- Vellora 依赖 Qt 等第三方组件，组件本身的漏洞也欢迎报告，我们会跟进升级。

- The installer and portable builds are not code-signed yet; download only from this repository's Releases and check the SHA256 on the release page.
- Vellora depends on Qt and other third-party components; reports about vulnerabilities in them are welcome too, and we will follow up with upgrades.
