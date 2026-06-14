# Markdown viewer

Markdown viewer は、Electron、React、TypeScript、Electron Vite で構築されたローカル優先の Markdown デスクトップアプリです。`.md` と `.markdown` ファイルを自分の PC 上で閲覧、検索、整理、軽量編集するためのツールです。

ほかの言語: [中文](README.md) | [English](README.en.md) | [Русский](README.ru.md)

## 主な機能

- Markdown ファイルを開き、見出し、引用、表、コードブロック、画像、リンクをローカルで表示します。
- フォルダーを開いて Markdown ファイルツリーを表示し、ファイルを絞り込めます。
- 現在の文書内を検索し、前後の検索結果へ移動できます。
- H1-H6 のアウトラインで長い文書を移動できます。
- 相対パスのローカル画像を解決し、見つからない画像にはプレースホルダーを表示します。
- WYSIWYG の閲覧編集モードと、ソース編集 + プレビューの分割表示を利用できます。
- ローカル Markdown リンクは制御された main process API で開き、外部 URL へ移動する前には確認を表示します。
- 現在のファイルをシステム既定のエディターで開けます。
- Windows では NSIS インストーラーを生成でき、インストール先と `.md` / `.markdown` の関連付けを選択できます。

## 開発方法

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

## セキュリティとデータ

Markdown viewer はユーザーの文書を既定でアップロードしません。ファイルの読み取り、保存、画像解決、リンクのオープンは、制御された Electron main/preload API を通じて実行されます。アプリを削除してもユーザーの Markdown ファイルは削除されません。

## ライセンス

このプロジェクトは MIT License の下で公開されています。全文は [LICENSE](LICENSE) を参照してください。
