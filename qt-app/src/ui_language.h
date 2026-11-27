// Picks the UI language once at startup: any Chinese system UI language
// (zh, zh-CN, zh-TW, zh-HK, zh-Hant, ...) shows the Simplified Chinese UI,
// every other language shows English. VELLORA_LANG=zh|en overrides it.
#pragma once

#include <QString>
#include <QStringList>

class QCoreApplication;

namespace ui_language {

enum class Language { Chinese, English };

// True for a BCP 47 / POSIX tag whose primary language is Chinese.
bool isChineseTag(const QString& tag);
// The rule: the first (preferred) system UI language decides. `override` is the
// VELLORA_LANG value; "zh" or "en" (any case, any region) wins over the system.
Language choose(const QStringList& uiLanguages, const QString& override = QString());
// Reads the system's preferred UI languages and VELLORA_LANG.
Language systemChoice();
// Installs the English translation on `app` (removes it for Chinese) and sets
// the language of the Rust core's messages. Call before creating any widget:
// existing widgets keep their text. Returns false when the English translation
// could not be loaded.
bool apply(QCoreApplication& app, Language language);
// Code of `language` as the bridge and VELLORA_LANG spell it: "zh" or "en".
QString tag(Language language);

}  // namespace ui_language
