# Vellora

Local-first lightweight Markdown viewer and source editor. **2.0** is built with **Tauri 2 + React + TypeScript + Vite** for opening a `.md` file, reading, editing, and saving quickly.

[中文](README.md) · [日本語](README.ja.md) · [Русский](README.ru.md)

## Features

- Open `.md` / `.markdown` (file picker, drag-and-drop, file association)
- Read-mode rendering: headings, lists, quotes, tables, fenced code, links, relative images
- Syntax highlight: bash, CSS, JavaScript, JSON, Markdown, TypeScript, HTML/XML
- Source edit (`textarea`) / read toggle; `Ctrl+S` to save
- Unsaved-change confirm on close or open another file
- In-document search (`Ctrl+F`) and collapsible outline
- Relative local Markdown links; HTTP(S) external links open only after confirm
- Single-instance on Windows: second launch forwards path to the existing window
- NSIS installer; WebView2 via download bootstrapper (runtime not bundled)

## What’s new in 2.0

Keeps core read/edit/security paths from 1.x (Electron). Removes workspace tree, recents, WYSIWYG (MDXEditor), command palette, PDF export, themes/i18n, complex native menus, etc.

Migration: **uninstall 1.x, then install 2.0** (clean migration).

| Approx. size | 1.x Electron | 2.0 Tauri |
|--------------|--------------|-----------|
| Installer    | ~100+ MiB    | ~1.5 MiB  |
| App binary   | ~200+ MiB    | a few MiB |

## Install

### Prebuilt (Windows)

Download `Vellora_2.0.0_x64-setup.exe` from [Releases](https://github.com/mirad-tech/markdown-viewer/releases).

**WebView2** is required (usually preinstalled on Windows 10/11).

### From source

**Prerequisites (Windows):** Node.js 20+, Rust MSVC toolchain, VS C++ Build Tools, WebView2.

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run test:rust
npm run test:e2e
npm run dist
```

Installer output:

`src-tauri/target/release/bundle/nsis/Vellora_2.0.0_x64-setup.exe`

## Security

- Only `.md` / `.markdown`
- Images and local Markdown links are limited to the **current document directory**; images ≤ 10 MiB
- External links: HTTP(S) only, after UI confirm; blocks dangerous protocols
- Tauri capabilities expose custom commands only (no generic FS/Shell/network)
- No upload of user documents; uninstall does not delete user Markdown files

## Architecture

```
src/           React (Vite)
src-tauri/     Rust / Tauri
tests/e2e/     E2E (browser mock; optional desktop WDIO)
```

## License

MIT — see [LICENSE](LICENSE). Version **2.0.0**. Changelog: [CHANGELOG.md](CHANGELOG.md).

Issues: <https://github.com/mirad-tech/markdown-viewer/issues>
