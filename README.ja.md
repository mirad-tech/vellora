# Vellora

**Windows 専用**のローカル優先・軽量 Markdown ビューア / ソースエディタです。  
**2.0** は **Tauri 2 + React + TypeScript + Vite** で構築されています。

リポジトリ名は `markdown-viewer`、製品名は **Vellora** です。

詳細は [中文 README](README.md) または [English README](README.en.md) を参照してください。

## ダウンロード（Windows x64）

[**Vellora 2.0.0 インストーラ**](https://github.com/mirad-tech/markdown-viewer/releases/download/v2.0.0/Vellora_2.0.0_x64-setup.exe)

- ファイル名：`Vellora_2.0.0_x64-setup.exe`
- 全リリース：[Releases](https://github.com/mirad-tech/markdown-viewer/releases)
- **WebView2** が必要（通常は OS に同梱。インストールパッケージには埋め込みません）
- 1.x（Electron）から：先に 1.x をアンインストールしてから 2.0 を入れてください

## 概要

- `.md` / `.markdown` の表示・ソース編集・保存
- 相対パス画像、ローカル Markdown リンク、HTTP(S) 外部リンク確認
- 単一インスタンス、未保存確認、検索、見出しアウトライン

## 開発

```bash
npm install
npm run dev
npm run dist
```

## ライセンス

MIT — [LICENSE](LICENSE)
