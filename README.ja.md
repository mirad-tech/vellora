# Vellora

**Windows / macOS 対応**のローカル優先・軽量 Markdown ビューア / ソースエディタです。
現在のバージョンは **2.2.5**。**Tauri 2 + React + TypeScript + Vite** で構築されています。

リポジトリ：[`mirad-tech/vellora`](https://github.com/mirad-tech/vellora)。製品名は **Vellora** です。

[中文](README.md) · [English](README.en.md) · 日本語 · [Русский](README.ru.md)

## ダウンロード

| プラットフォーム | 対応状況 | 入手方法 |
|---|---|---|
| Windows 10/11 x64 | 現在の公開版は 2.2.5 | NSIS インストーラをダウンロード |
| macOS 12+（Apple Silicon / Intel） | ソースと Universal DMG ビルドを両アーキテクチャの CI で検証済み。正式な macOS Release アセットは未提供 | ソースから ad-hoc テスト版をビルド |

### Windows 10/11 x64

[**Vellora 2.2.5 インストーラ**](https://github.com/mirad-tech/vellora/releases/download/v2.2.5/Vellora_2.2.5_x64-setup.exe)

- ファイル名：`Vellora_2.2.5_x64-setup.exe`
- 全リリース：[Releases](https://github.com/mirad-tech/vellora/releases)
- **WebView2** が必要（通常は OS に同梱。インストールパッケージには埋め込みません）
- 1.x（Electron）から：先に 1.x をアンインストールしてから最新版を入れてください

### macOS 12+

ソースは引き続き `arm64` / `x86_64` を含む Universal アプリと DMG に対応しています。正式な GitHub Release は Windows NSIS のみを公開し、macOS DMG はローカル / CI 用の ad-hoc 検証成果物で、正式な Release アセットではありません。テスト版は [macOS ビルド・検証手順](mac/README.md) を参照してください。

## 概要

- `.md` / `.markdown` の表示・ソース編集・保存
- 相対パス画像、ローカル Markdown リンク、HTTP(S) 外部リンク確認
- 単一インスタンス、未保存確認、プレビュー / ソース両モードでの検索、見出しアウトライン
- Windows は `Ctrl+S` / `Ctrl+F`、macOS は `⌘S` / `⌘F`。プレビューとソース表示は同じ右端スクロールバーを使用

## 開発

```bash
npm install
npm run dev
npm run dist
```

macOS では `npm run dev:mac`、`npm run test:e2e:mac`、`npm run dist:mac` を使用します。

## ライセンス

MIT — [LICENSE](LICENSE)
