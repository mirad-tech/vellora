// User-visible text. The Simplified Chinese source text is the key and the
// Chinese UI; translations/vellora_en.ts holds the English, which is installed
// only when the system's UI language is not Chinese (see ui_language.h).
// One context keeps a term translated the same way everywhere, and
// tools/check_translations.py checks that every string here has an English one.
#pragma once

#include <QCoreApplication>
#include <QString>

namespace ui {

inline constexpr char kContext[] = "Vellora";

// `n` >= 0 replaces %n and picks the English plural form.
inline QString tr(const char* source, int n = -1) {
  return QCoreApplication::translate(kContext, source, nullptr, n);
}

// Text that names where deleted files go: the Recycle Bin on Windows, the
// Trash elsewhere. Chinese says 回收站 on both.
inline QString trTrash(const char* source) {
#ifdef Q_OS_WIN
  return QCoreApplication::translate(kContext, source, "recycle-bin");
#else
  return QCoreApplication::translate(kContext, source, "trash");
#endif
}

}  // namespace ui
