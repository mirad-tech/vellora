# Vellora

Локальный лёгкий просмотрщик и редактор Markdown для **Windows и macOS**.
Текущая версия — **2.2.2**, на **Tauri 2 + React + TypeScript + Vite**.

Репозиторий: [`mirad-tech/vellora`](https://github.com/mirad-tech/vellora). Продукт: **Vellora**.

Подробности: [中文 README](README.md) или [English README](README.en.md).

## Скачать (Windows x64)

[**Установщик Vellora 2.2.2**](https://github.com/mirad-tech/vellora/releases/download/v2.2.2/Vellora_2.2.2_x64-setup.exe)

- Имя файла: `Vellora_2.2.2_x64-setup.exe`
- Все версии: [Releases](https://github.com/mirad-tech/vellora/releases)
- Нужен **WebView2** (обычно уже есть в системе; runtime не вшивается в установщик)
- С 1.x (Electron): сначала удалите 1.x, затем установите последнюю версию

Исходники и CI уже поддерживают Universal DMG для macOS 12+, но официальный macOS-ресурс для 2.2.2 ещё не опубликован. Локальная ad-hoc сборка описана в [инструкции macOS](mac/README.md).

## Кратко

- Открытие `.md` / `.markdown`, чтение, правка исходника, сохранение
- Относительные изображения, локальные Markdown-ссылки, подтверждение HTTP(S)
- Один экземпляр, защита несохранённых изменений, поиск в режиме просмотра и исходника, оглавление
- Windows: `Ctrl+S` / `Ctrl+F`; macOS: `⌘S` / `⌘F`; просмотр и исходник используют общую полосу прокрутки справа

## Разработка

```bash
npm install
npm run dev
npm run dist
```

На macOS используйте `npm run dev:mac`, `npm run test:e2e:mac` и `npm run dist:mac`.

## Лицензия

MIT — [LICENSE](LICENSE)
