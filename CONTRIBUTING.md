# 参与贡献

中文 | [English](#contributing-english)

感谢你愿意改进 Vellora。问题、建议和代码都欢迎。

## 报告问题和提建议

- 先搜一下 [Issues](https://github.com/mirad-tech/vellora/issues)，看是否已有人报过。
- 新建问题时选择“故障报告”或“功能建议”模板，填写版本号、系统和复现步骤。
- 安全问题请不要公开提 Issue，见 [SECURITY.md](SECURITY.md)。

## 开发环境

编译所需的工具和命令见 README 的 [构建](README.md#构建) 一节（Windows 与 Linux 都有）。

提交前请在本地跑通测试：

- Windows：`.\qt-app\build.ps1 -QtRoot <Qt 路径> -Test -EmitLegacyOutput $false`，或用 `.\tools\check.ps1` 只检查 Rust 部分（格式、Clippy、测试）。
- Linux：`./qt-app/build.sh --test`

## 代码约定

- Rust 用 `cargo fmt` 格式化，`cargo clippy --workspace --all-targets -- -D warnings` 不能有警告。
- C++ 按仓库里的 `.clang-format` 格式化。
- 新增或修改界面文字时，同时在 `qt-app/translations/vellora_en.ts` 补上英文翻译，并运行 `python tools/check_translations.py`。英文请写自然、简短的说法，界面放不下时用缩写，不要改布局。
- 不修改发布版本号；版本号由维护者在发版时统一修改。

## 提交 PR

1. 从 `main` 新建分支，一个 PR 只做一件事。
2. 提交说明用英文，简短写清改了什么。
3. 发 PR 后按模板填写说明和自查清单。
4. 合并前所有必需检查（CI）必须通过。只改 `.md` 文件的 PR 会跳过编译测试。
5. 由维护者审核并合并。

提交的代码以 [MIT 许可证](LICENSE) 授权。参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

---

## Contributing (English)

Thanks for helping improve Vellora. Bug reports, ideas, and code are all welcome.

### Reporting bugs and suggesting features

- Search the [Issues](https://github.com/mirad-tech/vellora/issues) first in case it has already been reported.
- Use the "Bug report" or "Feature request" template and include the version, your OS, and steps to reproduce.
- Do not open public issues for security problems; see [SECURITY.md](SECURITY.md).

### Development setup

See the [Building](README.en.md#building) section of the English README for tools and commands on Windows and Linux.

Run the tests locally before submitting:

- Windows: `.\qt-app\build.ps1 -QtRoot <Qt path> -Test -EmitLegacyOutput $false`, or `.\tools\check.ps1` for the Rust checks only (format, Clippy, tests).
- Linux: `./qt-app/build.sh --test`

### Conventions

- Format Rust with `cargo fmt`; `cargo clippy --workspace --all-targets -- -D warnings` must be clean.
- Format C++ with the repository's `.clang-format`.
- When you add or change interface text, add the English translation to `qt-app/translations/vellora_en.ts` and run `python tools/check_translations.py`. Keep the English natural and short; abbreviate rather than change the layout.
- Don't bump the release version; the maintainer does that when releasing.

### Pull requests

1. Branch from `main`; one change per PR.
2. Write short commit messages in English that say what changed.
3. Fill in the PR template's description and checklist.
4. All required checks (CI) must pass before merging. PRs that only touch `.md` files skip the build and tests.
5. The maintainer reviews and merges.

Contributions are licensed under the [MIT License](LICENSE). By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
