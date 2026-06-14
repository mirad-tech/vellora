# Markdown viewer

Markdown viewer is a local-first desktop Markdown reader and editor built with Electron, React, TypeScript, and Electron Vite. It is designed for users who want to open, navigate, search, and lightly edit `.md` and `.markdown` files on their own machine.

Other languages: [中文](README.md) | [日本語](README.ja.md) | [Русский](README.ru.md)

## Features

- Open Markdown files and render headings, blockquotes, tables, code blocks, images, and links locally.
- Open a folder, browse the Markdown file tree, and filter files.
- Search within the current document and jump through matches.
- Navigate long documents with an H1-H6 outline.
- Resolve local relative images and show placeholders for missing images.
- Edit in WYSIWYG reading mode or source-edit split view, with unsaved-change tracking.
- Open local Markdown links through controlled main-process APIs and confirm before visiting external URLs.
- Open the current file in the system default editor.
- Package for Windows with an NSIS installer, custom install path, and optional `.md` / `.markdown` file association.

## Development

```bash
npm install
npm run dev
```

Common commands:

- `npm run typecheck`: Run TypeScript checks.
- `npm test`: Run Vitest unit tests and packaging configuration tests.
- `npm run build`: Build main, preload, and renderer output into `out/`.
- `npm run dist`: Build the Windows NSIS installer into `release/`.
- `npm run test:e2e:stageN`: Run a specific Playwright E2E stage, for example `npm run test:e2e:stage5`.

## Security And Data

Markdown viewer does not upload user documents by default. File reads, saves, image resolution, and link opening are routed through controlled Electron main/preload APIs. Removing the application does not remove the user's Markdown documents.

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for the full text.
