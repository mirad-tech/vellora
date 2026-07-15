# Vellora

ローカル優先の軽量 Markdown ビューア / ソースエディタです。**2.0** は **Tauri 2 + React + TypeScript + Vite** で構築されています。

詳細は [中文 README](README.md) または [English README](README.en.md) を参照してください。

## 概要

- `.md` / `.markdown` の表示・ソース編集・保存
- 相対パス画像、ローカル Markdown リンク、HTTP(S) 外部リンク確認
- Windows NSIS インストーラ（WebView2 はバンドルしません）
- 1.x（Electron）からの移行：先に 1.x をアンインストールしてから 2.0 を入れてください

## 開発

```bash
npm install
npm run dev
npm run dist
```

## ライセンス

MIT — [LICENSE](LICENSE)
