# Vellora

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Vellora icon">
</p>

Vellora is a **local-first Markdown reader and source editor for Windows and macOS**. Its workflow is intentionally focused: open a `.md` file, read it comfortably, make a quick change, and save.

Built with **Tauri 2 + React + TypeScript + Vite**. Documents stay on the local machine.

[中文](README.md) · [日本語](README.ja.md) · [Русский](README.ru.md)

## Download

| Platform | Support status | How to get it |
|---|---|---|
| Windows 10/11 x64 | Current public release: 2.2.3 | Download the NSIS installer |
| macOS 12+ (Apple Silicon / Intel) | Universal app and DMG verified by native CI on both architectures; no macOS asset in 2.2.3 | Build an ad-hoc test package from source |

### Windows 10/11 x64

[**Download Vellora 2.2.3 (NSIS)**](https://github.com/mirad-tech/vellora/releases/download/v2.2.3/Vellora_2.2.3_x64-setup.exe)

- All versions: [GitHub Releases](https://github.com/mirad-tech/vellora/releases)
- Asset: `Vellora_2.2.3_x64-setup.exe`
- Requires Microsoft WebView2, normally included with Windows 10/11; the installer can bootstrap it if missing
- When upgrading from Electron 1.x, uninstall 1.x first; uninstalling does not remove Markdown documents

### macOS 12+

The source tree continues to build a Universal app and DMG containing both `arm64` and `x86_64`. The 2.2.3 Release is Windows-only and does not publish a signed DMG; see the [macOS build and verification guide](mac/README.md) for an ad-hoc test build.

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

Requirements: Windows 10/11, Node.js 20.19+, 22.12+, or newer; [Rust MSVC](https://rustup.rs/); Visual Studio C++ Build Tools; and WebView2.

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run test:rust
npm run test:e2e
npm run build:web
npm run dist
```

Installer output:

`src-tauri/target/release/bundle/nsis/Vellora_2.2.3_x64-setup.exe`

Real desktop E2E uses `npm run test:e2e:desktop` with external `tauri-driver` and a matching Edge WebDriver. Release builds never embed WebDriver and the test does not silently fall back to mocks.

On macOS, install Xcode Command Line Tools and both Apple Rust targets, then use `npm run dev:mac`, `npm run test:e2e:mac`, or `npm run dist:mac`. The macOS E2E driver is feature-gated and is not present in production bundles. See [mac/README.md](mac/README.md).

## Security

- Opens and saves `.md` / `.markdown` only
- Images and local Markdown links stay within the current document directory; images are limited to 10 MiB
- External URLs are HTTP(S) only and require confirmation
- Tauri capabilities expose only the required custom commands
- Documents are not uploaded; uninstall does not delete user files

## Repository and releases

Version: **2.2.3**. CI runs on `main` and pull requests across Windows, native Apple Silicon, and native Intel runners. macOS CI exercises the real desktop app, verifies a Universal DMG, and checks the Apple Silicon runner's artifact again on Intel. A matching `vX.Y.Z` tag builds Windows and macOS assets; the macOS release job fails closed unless Developer ID signing and notarization secrets are configured.

- [Changelog](CHANGELOG.md)
- [Issues](https://github.com/mirad-tech/vellora/issues)
- [MIT License](LICENSE)

App id: `app.markdown-viewer.desktop`.
