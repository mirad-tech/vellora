<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Значок Vellora">
</p>

<h1 align="center">Vellora</h1>

<p align="center">
  Локальный лёгкий просмотрщик и редактор Markdown для Windows и macOS.
</p>

<p align="center">
  <a href="https://github.com/mirad-tech/vellora/actions/workflows/ci.yml"><img src="https://github.com/mirad-tech/vellora/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/mirad-tech/vellora/releases/latest"><img src="https://img.shields.io/github/v/release/mirad-tech/vellora?display_name=tag&amp;sort=semver" alt="Последний выпуск"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/mirad-tech/vellora" alt="Лицензия MIT"></a>
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="docs/assets/vellora-preview.png" width="960" alt="Vellora просматривает документ Markdown в Windows">
</p>

Текущая версия — **2.2.5**, на **Tauri 2 + React + TypeScript + Vite**. Документы обрабатываются локально и не загружаются на сервер.

Репозиторий: [`mirad-tech/vellora`](https://github.com/mirad-tech/vellora). Продукт: **Vellora**.

## Скачать

| Платформа | Статус поддержки | Как получить |
|---|---|---|
| Windows 10/11 x64 | Текущая публичная версия — 2.2.5 | Скачать установщик NSIS |
| macOS 12+ (Apple Silicon / Intel) | Исходники и сборка Universal DMG проверены в CI на обеих архитектурах; официального артефакта macOS в GitHub Release нет | Собрать тестовый ad-hoc пакет из исходников |

### Windows 10/11 x64

[**Установщик Vellora 2.2.5**](https://github.com/mirad-tech/vellora/releases/download/v2.2.5/Vellora_2.2.5_x64-setup.exe)

- Имя файла: `Vellora_2.2.5_x64-setup.exe`
- Все версии: [Releases](https://github.com/mirad-tech/vellora/releases)
- Нужен **WebView2** (обычно уже есть в системе; runtime не вшивается в установщик)
- С 1.x (Electron): сначала удалите 1.x, затем установите последнюю версию

### macOS 12+

Исходники по-прежнему создают Universal-приложение и DMG с `arm64` и `x86_64`. Официальные GitHub Releases публикуют только Windows NSIS; macOS DMG используется как ad-hoc артефакт для локальной проверки и CI, а не как официальный артефакт Release. Тестовая сборка описана в [инструкции по сборке и проверке macOS](mac/README.md).

## Кратко

- Открытие `.md` / `.markdown`, чтение, правка исходника, сохранение
- Относительные изображения, локальные Markdown-ссылки, подтверждение HTTP(S)
- Один экземпляр, защита несохранённых изменений, поиск в режиме просмотра и исходника, оглавление
- Windows: `Ctrl+S` / `Ctrl+F`; macOS: `⌘S` / `⌘F`; просмотр и исходник используют общую полосу прокрутки справа

## Разработка

Нужен Node.js 22.22.2+ (22.x), 24.15+ (24.x) или 26+.

```bash
npm install
npm run dev
npm run dist
```

На macOS используйте `npm run dev:mac`, `npm run test:e2e:mac` и `npm run dist:mac`.

## Лицензия

MIT — [LICENSE](LICENSE)
