# Vellora

**Windows-only**, local-first lightweight Markdown viewer and source editor.  
**2.0** is built with **Tauri 2 + React + TypeScript + Vite** — open a `.md` file, read, edit, and save.

> Platform: **Windows only** (NSIS + WebView2). Repository: [`mirad-tech/vellora`](https://github.com/mirad-tech/vellora).

[中文](README.md) · [日本語](README.ja.md) · [Русский](README.ru.md)

## Download (Windows x64)

[**Vellora 2.0.0 setup (NSIS)**](https://github.com/mirad-tech/vellora/releases/download/v2.0.0/Vellora_2.0.0_x64-setup.exe)

- Asset name: `Vellora_2.0.0_x64-setup.exe` (~1.5 MiB)
- All versions: [Releases](https://github.com/mirad-tech/vellora/releases)
- Requires **WebView2** (usually preinstalled on Windows 10/11; installer can bootstrap if missing — runtime is not bundled)

Upgrading from 1.x (Electron): **uninstall 1.x first, then install 2.0**.

## Features

- Open `.md` / `.markdown` (file picker, drag-and-drop, file association)
- Read-mode rendering: headings, lists, quotes, tables, fenced code, links, relative images
- Syntax highlight: bash, CSS, JavaScript, JSON, Markdown, TypeScript, HTML/XML
- Source edit (`textarea`) / read toggle; `Ctrl+S` to save
- Unsaved-change confirm on close or open another file
- In-document search (`Ctrl+F`) and collapsible outline
- Relative local Markdown links; HTTP(S) external links open only after confirm
- Single-instance: second launch forwards path to the existing window

## What’s new in 2.0

| | 1.x Electron | 2.0 Tauri |
|--|--------------|-----------|
| Installer (approx.) | ~100+ MiB | ~1.5 MiB |
| App binary (approx.) | ~200+ MiB | a few MiB |
| Focus | Workspace, recents, WYSIWYG, PDF, … | Single-document read / source edit |

**Removed:** workspace tree, recents, WYSIWYG (MDXEditor), command palette, PDF export, themes/i18n, complex native menus, etc.

## Build from source

**Prerequisites (Windows):** Node.js 20+, [Rust MSVC](https://rustup.rs/), VS C++ Build Tools, WebView2.

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run test:rust
npm run test:e2e
npm run dist
```

### Desktop E2E (real IPC, external drivers)

Release builds **do not** embed WebDriver. Desktop E2E uses external drivers and **never** falls back to mocks:

1. **Close every running Vellora window first.** Before driver checks / build, and again after the release build, if any `vellora.exe` is found the script **aborts safely** without ending those processes.
2. If process status cannot be queried (PowerShell/CIM failure, invalid response, etc.), the script also **aborts safely** and does not treat a query failure as “no processes”.
3. `cargo install tauri-driver --locked` (on PATH)
4. Install `msedgedriver` matching your Edge major version (required native driver for `tauri-driver`; cannot be omitted):
   - Recommended: `npm run tools:msedgedriver` (installs to `tools/webdriver/msedgedriver.exe`; the launcher finds it automatically)
   - Or download from [Edge WebDriver](https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver/) and put it on PATH / set `MSEDGEDRIVER_PATH`
5. Docs: [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)

```bash
npm run test:e2e:desktop
```

**Process safety (verifiable):**

- Each run generates a unique session token `VELLORA_E2E_SESSION` (UUID) and passes `--vellora-e2e-session=<UUID>` to the test app instance.
- Cleanup only stops: the WDIO and `tauri-driver` processes this script spawned, plus Vellora processes that, on **re-query**, match both the release `vellora.exe` path and the full session token in the command line.
- It does not use `taskkill /IM vellora.exe`, bulk-kill by name/path, or infer ownership from “appeared after the test started”.
- If re-query fails during cleanup: WDIO / `tauri-driver` may still be stopped, but **no** unverified Vellora PID is killed, and the E2E run is marked failed.

Missing drivers, version mismatch, a pre-existing Vellora process, or a process-query failure fails the run with a non-zero exit code.

Desktop E2E builds with `cargo build --release --features custom-protocol` so the app loads embedded frontend assets (not the dev server at `http://localhost:1420`). For installers use `npm run build` / `tauri build`.


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

App id: `app.markdown-viewer.desktop` (Windows package identity; kept across 1.x→2.0).  
Issues: <https://github.com/mirad-tech/vellora/issues>
