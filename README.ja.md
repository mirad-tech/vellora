# Vellora

**Windows / macOS 対応**のローカル優先・軽量 Markdown ビューア / ソースエディタです。
現在のバージョンは **2.2.2**。**Tauri 2 + React + TypeScript + Vite** で構築されています。

リポジトリ：[`mirad-tech/vellora`](https://github.com/mirad-tech/vellora)。製品名は **Vellora** です。

詳細は [中文 README](README.md) または [English README](README.en.md) を参照してください。

## ダウンロード（Windows x64）

[**Vellora 2.2.2 インストーラ**](https://github.com/mirad-tech/vellora/releases/download/v2.2.2/Vellora_2.2.2_x64-setup.exe)

- ファイル名：`Vellora_2.2.2_x64-setup.exe`
- 全リリース：[Releases](https://github.com/mirad-tech/vellora/releases)
- **WebView2** が必要（通常は OS に同梱。インストールパッケージには埋め込みません）
- 1.x（Electron）から：先に 1.x をアンインストールしてから最新版を入れてください

macOS 12+ Universal DMG のソースと CI は追加済みですが、2.2.2 の正式 macOS アセットは未公開です。ローカルの ad-hoc ビルドは [macOS ビルド手順](mac/README.md) を参照してください。

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
