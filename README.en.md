# Vellora

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Vellora icon">
</p>

Vellora is a **Windows-only, local-first Markdown reader and source editor**. Its workflow is intentionally focused: open a `.md` file, read it comfortably, make a quick change, and save.

Built with **Tauri 2 + React + TypeScript + Vite**. Documents stay on the local machine.

[中文](README.md) · [日本語](README.ja.md) · [Русский](README.ru.md)

## Download

For **Windows 10/11 x64**:

[**Download Vellora 2.2.0 (NSIS)**](https://github.com/mirad-tech/vellora/releases/download/v2.2.0/Vellora_2.2.0_x64-setup.exe)

- All versions: [GitHub Releases](https://github.com/mirad-tech/vellora/releases)
- Asset: `Vellora_2.2.0_x64-setup.exe`
- Requires Microsoft WebView2, normally included with Windows 10/11; the installer can bootstrap it if missing
- When upgrading from Electron 1.x, uninstall 1.x first; uninstalling does not remove Markdown documents

## Features

- Open `.md` / `.markdown` through the picker, drag-and-drop, or file association
- Render headings, lists, quotes, tables, fenced code, links, and relative images
- Switch between reading and lightweight source editing
- Quick-edit supported blocks from reading mode; `Ctrl+Enter` commits and `Escape` cancels
- Compact in-document search with result navigation
- Collapsible outline that follows the current reading position
- Unsaved-change confirmation before close or document switches
- Directory-bounded local Markdown links and confirmed HTTP(S) external links
- Single-instance file forwarding

The interface uses a low-emphasis warm-paper palette. Read and source modes share the window-edge scrollbar, and syntax highlighting stays intentionally restrained.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+F` | Find in document |
| `Enter` / `Shift+Enter` | Next / previous match |
| `Escape` | Close the active overlay or cancel quick edit |
| `Ctrl+Enter` | Commit a reading-mode quick edit |

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

`src-tauri/target/release/bundle/nsis/Vellora_2.2.0_x64-setup.exe`

Real desktop E2E uses `npm run test:e2e:desktop` with external `tauri-driver` and a matching Edge WebDriver. Release builds never embed WebDriver and the test does not silently fall back to mocks.

## Security

- Opens and saves `.md` / `.markdown` only
- Images and local Markdown links stay within the current document directory; images are limited to 10 MiB
- External URLs are HTTP(S) only and require confirmation
- Tauri capabilities expose only the required custom commands
- Documents are not uploaded; uninstall does not delete user files

## Repository and releases

Version: **2.2.0**. CI runs on `main` and pull requests. Pushing a signed or annotated `vX.Y.Z` tag builds the Windows installer, creates a GitHub Release, and uploads the matching asset.

- [Changelog](CHANGELOG.md)
- [Issues](https://github.com/mirad-tech/vellora/issues)
- [MIT License](LICENSE)

App id: `app.markdown-viewer.desktop`.
