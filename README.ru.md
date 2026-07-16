# Vellora

**Только Windows.** Локальный лёгкий просмотрщик и редактор Markdown.  
**2.0** построен на **Tauri 2 + React + TypeScript + Vite**.

Репозиторий: [`mirad-tech/vellora`](https://github.com/mirad-tech/vellora). Продукт: **Vellora**.

Подробности: [中文 README](README.md) или [English README](README.en.md).

## Скачать (Windows x64)

[**Установщик Vellora 2.0.0**](https://github.com/mirad-tech/vellora/releases/download/v2.0.0/Vellora_2.0.0_x64-setup.exe)

- Имя файла: `Vellora_2.0.0_x64-setup.exe`
- Все версии: [Releases](https://github.com/mirad-tech/vellora/releases)
- Нужен **WebView2** (обычно уже есть в системе; runtime не вшивается в установщик)
- С 1.x (Electron): сначала удалите 1.x, затем установите 2.0

## Кратко

- Открытие `.md` / `.markdown`, чтение, правка исходника, сохранение
- Относительные изображения, локальные Markdown-ссылки, подтверждение HTTP(S)
- Один экземпляр, несохранённые изменения, поиск, оглавление

## Разработка

```bash
npm install
npm run dev
npm run dist
```

## Лицензия

MIT — [LICENSE](LICENSE)
