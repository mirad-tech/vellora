<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Vellora icon">
</p>

<h1 align="center">Vellora</h1>

<p align="center">
  A local-first Markdown reader and source editor. Windows ships as an official installer; macOS is supported for source, CI, and ad-hoc builds.
</p>

<p align="center">
  <a href="https://github.com/mirad-tech/vellora/actions/workflows/ci.yml"><img src="https://github.com/mirad-tech/vellora/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/mirad-tech/vellora/releases/latest"><img src="https://img.shields.io/github/v/release/mirad-tech/vellora?display_name=tag&amp;sort=semver" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/mirad-tech/vellora" alt="MIT License"></a>
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <img src="docs/assets/vellora-preview.png" width="960" alt="Vellora previewing a Markdown document on Windows">
</p>

Documents are processed locally and are not uploaded to a server. Vellora is built with **Tauri 2 + React + TypeScript + Vite** and stays focused on opening, reading, quickly editing, and saving one Markdown document.

## Download

| Platform | Support status | How to get it |
|---|---|---|
| Windows 10/11 x64 | Current public release: 2.2.5 | Download the NSIS installer |
| macOS 12+ (Apple Silicon / Intel) | Source and Universal DMG builds verified by native CI on both architectures; no official macOS Release asset | Build an ad-hoc test package from source |

### Windows 10/11 x64

[**Download Vellora 2.2.5 (NSIS)**](https://github.com/mirad-tech/vellora/releases/download/v2.2.5/Vellora_2.2.5_x64-setup.exe)

- All versions: [GitHub Releases](https://github.com/mirad-tech/vellora/releases)
- Asset: `Vellora_2.2.5_x64-setup.exe`
- Requires Microsoft WebView2, normally included with Windows 10/11; the installer can bootstrap it if missing
- When upgrading from Electron 1.x, uninstall 1.x first; uninstalling does not remove Markdown documents

### macOS 12+

The source tree continues to build a Universal app and DMG containing both `arm64` and `x86_64`. Official GitHub Releases publish the Windows NSIS installer only; macOS DMGs are ad-hoc artifacts for local and CI verification, not official release assets. See the [macOS build and verification guide](mac/README.md) for a test build.

## Features

- Open `.md` / `.markdown` through the picker, drag-and-drop, or file association
- Render headings, lists, quotes, tables, fenced code, links, and relative images
- Switch between reading and lightweight source editing
- Quick-edit supported blocks from reading mode; `Ctrl+Enter` / `⌘Enter` commits and `Escape` cancels
- Compact in-document search in read and source modes, with result counts and previous/next navigation
- Collapsible outline that follows the current reading position
- Unsaved-change confirmation before close or document switches
- Directory-bounded local Markdown links and confirmed HTTP(S) external links
- Single-instance file forwarding

The interface uses a low-emphasis warm-paper palette. Read and source modes share the window-edge scrollbar, and syntax highlighting stays intentionally restrained.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` / `⌘S` | Save |
| `Ctrl+F` / `⌘F` | Find in document |
| `Enter` / `Shift+Enter` | Next / previous match |
| `Escape` | Close the active overlay or cancel quick edit |
| `Ctrl+Enter` / `⌘Enter` | Commit a reading-mode quick edit |

Find and save are keyboard-first and do not occupy toolbar buttons.

## Build from source

Requirements: Windows 10/11; Node.js 22.22.2+ on the 22.x line, 24.15+ on the 24.x line, or 26+; [Rust MSVC](https://rustup.rs/); Visual Studio C++ Build Tools; and WebView2.

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run test:rust
npm run build:web
npm run dist
```

Installer output:

`src-tauri/target/release/bundle/nsis/Vellora_2.4.2_x64-setup.exe`

On macOS, use Node.js 22.22.2+ on the 22.x line, 24.15+ on the 24.x line, or 26+, install Xcode Command Line Tools and both Apple Rust targets, then use `npm run dev:mac` or `npm run dist:mac`. See [mac/README.md](mac/README.md).

## Security

- Opens and saves `.md` / `.markdown` only
- Images and local Markdown links stay within the current document directory; images are limited to 10 MiB
- External URLs are HTTP(S) only and require confirmation
- Tauri capabilities expose only the required custom commands
- Documents are not uploaded; uninstall does not delete user files

## Repository and releases

Source version: **2.4.2**; see the download section for the public release. CI runs on `main` and pull requests across Windows, native Apple Silicon, and native Intel runners. macOS CI exercises the real desktop app, verifies an ad-hoc Universal DMG, and checks the Apple Silicon runner's artifact again on Intel. A matching `vX.Y.Z` tag builds and publishes the Windows NSIS installer; macOS remains supported for source builds and CI verification without an official signed DMG asset.

- [Changelog](CHANGELOG.md)
- [Issues](https://github.com/mirad-tech/vellora/issues)
- [MIT License](LICENSE)

App id: `app.markdown-viewer.desktop`.
