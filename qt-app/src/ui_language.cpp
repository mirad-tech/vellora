#include "ui_language.h"

#include <QCoreApplication>
#include <QLocale>
#include <QTranslator>

#include "bridge.h"

namespace ui_language {

namespace {

QString primarySubtag(const QString& tag) {
  // "zh-Hant-TW", "zh_TW.UTF-8" and "zh@stroke" all start with the language.
  const QString trimmed = tag.trimmed().toLower();
  qsizetype end = 0;
  while (end < trimmed.size() && trimmed.at(end).isLetter())
    ++end;
  return trimmed.left(end);
}

}  // namespace

bool isChineseTag(const QString& tag) {
  return primarySubtag(tag) == QStringLiteral("zh");
}

Language choose(const QStringList& uiLanguages, const QString& override) {
  const QString forced = primarySubtag(override);
  if (forced == QStringLiteral("zh")) return Language::Chinese;
  if (forced == QStringLiteral("en")) return Language::English;
  return !uiLanguages.isEmpty() && isChineseTag(uiLanguages.first()) ? Language::Chinese
                                                                     : Language::English;
}

Language systemChoice() {
  // On Windows this is the display language; on Linux it follows LANGUAGE,
  // LC_ALL, LC_MESSAGES and LANG.
  return choose(QLocale::system().uiLanguages(), qEnvironmentVariable("VELLORA_LANG"));
}

QString tag(Language language) {
  return language == Language::English ? QStringLiteral("en") : QStringLiteral("zh");
}

bool apply(QCoreApplication& app, Language language) {
  bridge::setLanguage(tag(language));
  // Applying again replaces the previous choice, so tests can switch languages.
  const QString name = QStringLiteral("vellora-english");
  if (auto* previous = app.findChild<QTranslator*>(name, Qt::FindDirectChildrenOnly)) {
    QCoreApplication::removeTranslator(previous);
    delete previous;
  }
  if (language == Language::Chinese) return true;
  // Embedded by vellora.pro (CONFIG += lrelease embed_translations).
  auto* translator = new QTranslator(&app);
  translator->setObjectName(name);
  if (!translator->load(QStringLiteral(":/i18n/vellora_en.qm"))) {
    delete translator;
    return false;
  }
  QCoreApplication::installTranslator(translator);
  return true;
}

}  // namespace ui_language
