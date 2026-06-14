# Markdown viewer

Markdown viewer is a local-first Electron desktop app for reading, editing, searching, and packaging Markdown documents. The project is open source under the MIT License.

Languages: [中文](#中文) | [English](#english) | [日本語](#日本語) | [Русский](#русский)

## 中文

### 项目简介

Markdown查看器（Markdown viewer）是一个本地优先的 Markdown 桌面查看器，基于 Electron、React、TypeScript 和 Electron Vite 构建。它面向需要在本机打开 Markdown 文件、整理、搜索和轻量编辑 `.md` / `.markdown` 文件的用户。

### 功能特性

- 打开单个 Markdown 文件，并在本地渲染标题、引用、表格、代码块、图片和链接。
- 打开文件夹，浏览 Markdown 文件树，并通过筛选快速定位文档。
- 使用文档搜索和标题大纲在长文档中跳转。
- 解析相对路径本地图片，缺失图片会显示占位提示。
- 支持 WYSIWYG 阅读编辑和源码编辑分屏，保存前会跟踪未保存状态。
- 通过受控主进程 API 打开本地 Markdown 链接，并在访问外部链接前显示安全确认。
- 支持通过系统默认编辑器打开当前文件。
- Windows 打包使用 NSIS 安装包，可选择安装路径，并可关联 .md 和 `.markdown` 文件。

### 本地开发

```bash
npm install
npm run dev
```

常用命令：

- `npm run typecheck`: 运行 TypeScript 类型检查。
- `npm test`: 运行 Vitest 单元测试和打包配置测试。
- `npm run build`: 构建 main、preload 和 renderer 输出到 `out/`。
- `npm run dist`: 构建并生成 Windows NSIS 安装包到 `release/`。
- `npm run test:e2e:stageN`: 运行指定阶段的 Playwright E2E 测试，例如 `npm run test:e2e:stage5`。

### 安全与数据

应用不会主动上传用户文档。文件读取、保存、图片解析和链接打开都通过受控的 Electron main/preload API 执行。卸载或删除应用不会删除用户文档，也不会删除用户自己的 Markdown 文件。

### 许可证

本项目使用 MIT License。完整文本见 [LICENSE](LICENSE)。

## English

### Overview

Markdown viewer is a local-first desktop Markdown reader and editor built with Electron, React, TypeScript, and Electron Vite. It is designed for users who want to open, navigate, search, and lightly edit `.md` and `.markdown` files on their own machine.

### Features

- Open Markdown files and render headings, blockquotes, tables, code blocks, images, and links locally.
- Open a folder, browse the Markdown file tree, and filter files.
- Search within the current document and jump through matches.
- Navigate long documents with an H1-H6 outline.
- Resolve local relative images and show placeholders for missing images.
- Edit in WYSIWYG reading mode or source-edit split view, with unsaved-change tracking.
- Open local Markdown links through controlled main-process APIs and confirm before visiting external URLs.
- Open the current file in the system default editor.
- Package for Windows with an NSIS installer, custom install path, and optional `.md` / `.markdown` file association.

### Development

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

### Security And Data

Markdown viewer does not upload user documents by default. File reads, saves, image resolution, and link opening are routed through controlled Electron main/preload APIs. Removing the application does not remove the user's Markdown documents.

### License

This project is released under the MIT License. See [LICENSE](LICENSE) for the full text.

## 日本語

### 概要

Markdown viewer は、Electron、React、TypeScript、Electron Vite で構築されたローカル優先の Markdown デスクトップアプリです。`.md` と `.markdown` ファイルを自分の PC 上で閲覧、検索、整理、軽量編集するためのツールです。

### 主な機能

- Markdown ファイルを開き、見出し、引用、表、コードブロック、画像、リンクをローカルで表示します。
- フォルダーを開いて Markdown ファイルツリーを表示し、ファイルを絞り込めます。
- 現在の文書内を検索し、前後の検索結果へ移動できます。
- H1-H6 のアウトラインで長い文書を移動できます。
- 相対パスのローカル画像を解決し、見つからない画像にはプレースホルダーを表示します。
- WYSIWYG の閲覧編集モードと、ソース編集 + プレビューの分割表示を利用できます。
- ローカル Markdown リンクは制御された main process API で開き、外部 URL へ移動する前には確認を表示します。
- 現在のファイルをシステム既定のエディターで開けます。
- Windows では NSIS インストーラーを生成でき、インストール先と `.md` / `.markdown` の関連付けを選択できます。

### 開発方法

```bash
npm install
npm run dev
```

よく使うコマンド：

- `npm run typecheck`: TypeScript の型チェックを実行します。
- `npm test`: Vitest の単体テストとパッケージ設定テストを実行します。
- `npm run build`: main、preload、renderer をビルドして `out/` に出力します。
- `npm run dist`: Windows NSIS インストーラーを `release/` に生成します。
- `npm run test:e2e:stageN`: 指定した Playwright E2E ステージを実行します。例：`npm run test:e2e:stage5`。

### セキュリティとデータ

Markdown viewer はユーザーの文書を既定でアップロードしません。ファイルの読み取り、保存、画像解決、リンクのオープンは、制御された Electron main/preload API を通じて実行されます。アプリを削除してもユーザーの Markdown ファイルは削除されません。

### ライセンス

このプロジェクトは MIT License の下で公開されています。全文は [LICENSE](LICENSE) を参照してください。

## Русский

### Обзор

Markdown viewer — локальное настольное приложение для Markdown, созданное на Electron, React, TypeScript и Electron Vite. Оно подходит для чтения, поиска, навигации и легкого редактирования файлов `.md` и `.markdown` на компьютере пользователя.

### Возможности

- Открытие Markdown-файлов и локальный рендеринг заголовков, цитат, таблиц, блоков кода, изображений и ссылок.
- Открытие папки, просмотр дерева Markdown-файлов и фильтрация списка.
- Поиск по текущему документу и переход между найденными совпадениями.
- Навигация по длинным документам через структуру заголовков H1-H6.
- Разрешение относительных путей к локальным изображениям и показ заглушек для отсутствующих файлов.
- Редактирование в WYSIWYG-режиме чтения или в режиме исходного текста с предпросмотром.
- Открытие локальных Markdown-ссылок через контролируемые API основного процесса и подтверждение перед переходом по внешним URL.
- Открытие текущего файла в системном редакторе по умолчанию.
- Сборка Windows-установщика NSIS с выбором пути установки и необязательной ассоциацией файлов `.md` / `.markdown`.

### Разработка

```bash
npm install
npm run dev
```

Основные команды:

- `npm run typecheck`: Запускает проверку TypeScript.
- `npm test`: Запускает модульные тесты Vitest и тесты конфигурации упаковки.
- `npm run build`: Собирает main, preload и renderer в каталог `out/`.
- `npm run dist`: Создает Windows NSIS-установщик в каталоге `release/`.
- `npm run test:e2e:stageN`: Запускает выбранный этап Playwright E2E, например `npm run test:e2e:stage5`.

### Безопасность и данные

Markdown viewer по умолчанию не загружает пользовательские документы в сеть. Чтение, сохранение, разрешение изображений и открытие ссылок выполняются через контролируемые Electron main/preload API. Удаление приложения не удаляет Markdown-файлы пользователя.

### Лицензия

Проект распространяется по лицензии MIT. Полный текст находится в файле [LICENSE](LICENSE).
