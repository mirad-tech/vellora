# Native Menu and NSIS Refactor Walkthrough

## Summary

This refactor moves the Markdown viewer from a web-toolbar-first Electron shell to a native Windows desktop workflow inspired by Typora.

- Removed the React top toolbar and moved command entry to native `File`, `Edit`, `View`, and `Window` menus.
- Added IPC channels for native menu actions and renderer-triggered PDF export.
- Added a main-process PDF export backend using `webContents.printToPDF({ printBackground: true })` and `dialog.showSaveDialog`.
- Replaced portable packaging with an assisted NSIS installer.
- Added an NSIS custom page for optional `.md` / `.markdown` default file association.
- Added print CSS for clean PDF output without sidebars, status bars, modals, or find UI.

## Main Files Changed

- `src/shared/ipcChannels.ts`: added `menu-action` and `export-to-pdf`.
- `src/shared/documentTypes.ts`: added `PdfExportResult`.
- `src/preload/index.ts`, `src/preload/types.ts`: exposed `onMenuAction` and `exportToPdf`.
- `src/main/nativeMenu.ts`: defined and installed the native application menu.
- `src/main/pdfExport.ts`: implemented background PDF generation and save dialog writing.
- `src/main/index.ts`, `src/main/ipc.ts`: wired the menu and PDF IPC handler into the main process.
- `src/renderer/src/App.tsx`: subscribed to native menu actions, removed the web toolbar, added menu-triggered find bar, and routed PDF export through preload.
- `src/renderer/src/styles.css`: removed toolbar layout, tightened main content sizing, and added print/PDF styles.
- `package.json`: changed Windows target to NSIS and added file associations plus assisted installer options.
- `build/installer.nsh`: added optional Markdown association page and association cleanup when unchecked.
- `tests/stage8/packaging.test.ts`: updated packaging assertions from portable to NSIS.
- `tests/e2e/*.spec.ts`: updated affected flows to use native menu actions or the remaining empty-state entry.

## Verification Log

- `npm run typecheck`: passed.
- `npm test`: passed, 20 files / 60 tests.
- `npm run test:stage8`: passed.
- `npm run dist`: passed and produced `release/Markdown viewer Setup 1.0.0.exe`.
- `npm run test:e2e:stage8`: passed.
- Targeted e2e before final packaging:
  - `tests/e2e/stage3.spec.ts`: passed.
  - `tests/e2e/stage4.spec.ts`: passed.
  - `tests/e2e/stage6.spec.ts`: passed.
  - `tests/e2e/stage7.spec.ts`: passed.
- Manual PDF smoke test: opened a Markdown file with a local image, exported through `window.mdViewer.exportToPdf()`, and verified a non-empty `%PDF` output file.

## Release Artifact

- Current installer: `release/Markdown viewer Setup 1.0.0.exe`.
- The `release` folder may still contain older local artifacts from prior portable builds; those are not part of the tracked source changes.
