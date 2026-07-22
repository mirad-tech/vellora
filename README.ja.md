# Vellora

**Windows 専用**のローカル優先・軽量 Markdown ビューア / ソースエディタです。  
現在のバージョンは **2.2.1**。**Tauri 2 + React + TypeScript + Vite** で構築されています。

リポジトリ：[`mirad-tech/vellora`](https://github.com/mirad-tech/vellora)。製品名は **Vellora** です。

詳細は [中文 README](README.md) または [English README](README.en.md) を参照してください。

## ダウンロード（Windows x64）

[**Vellora 2.2.1 インストーラ**](https://github.com/mirad-tech/vellora/releases/download/v2.2.1/Vellora_2.2.1_x64-setup.exe)

- ファイル名：`Vellora_2.2.1_x64-setup.exe`
- 全リリース：[Releases](https://github.com/mirad-tech/vellora/releases)
- **WebView2** が必要（通常は OS に同梱。インストールパッケージには埋め込みません）
- 1.x（Electron）から：先に 1.x をアンインストールしてから最新版を入れてください

## 概要

- `.md` / `.markdown` の表示・ソース編集・保存
- 相対パス画像、ローカル Markdown リンク、HTTP(S) 外部リンク確認
- 単一インスタンス、未保存確認、検索、見出しアウトライン
- `Ctrl+S` で保存、`Ctrl+F` で検索。プレビューとソース表示は同じ右端スクロールバーを使用

## 開発

```bash
npm install
npm run dev
npm run dist
```

## ライセンス

MIT — [LICENSE](LICENSE)
