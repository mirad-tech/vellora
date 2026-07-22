# Vellora

**Только Windows.** Локальный лёгкий просмотрщик и редактор Markdown.  
Текущая версия — **2.2.0**, на **Tauri 2 + React + TypeScript + Vite**.

Репозиторий: [`mirad-tech/vellora`](https://github.com/mirad-tech/vellora). Продукт: **Vellora**.

Подробности: [中文 README](README.md) или [English README](README.en.md).

## Скачать (Windows x64)

[**Установщик Vellora 2.2.0**](https://github.com/mirad-tech/vellora/releases/download/v2.2.0/Vellora_2.2.0_x64-setup.exe)

- Имя файла: `Vellora_2.2.0_x64-setup.exe`
- Все версии: [Releases](https://github.com/mirad-tech/vellora/releases)
- Нужен **WebView2** (обычно уже есть в системе; runtime не вшивается в установщик)
- С 1.x (Electron): сначала удалите 1.x, затем установите последнюю версию

## Кратко

- Открытие `.md` / `.markdown`, чтение, правка исходника, сохранение
- Относительные изображения, локальные Markdown-ссылки, подтверждение HTTP(S)
- Один экземпляр, несохранённые изменения, поиск, оглавление
- `Ctrl+S` — сохранить, `Ctrl+F` — поиск; просмотр и исходник используют общую полосу прокрутки справа

## Разработка

```bash
npm install
npm run dev
npm run dist
```

## Лицензия

MIT — [LICENSE](LICENSE)
