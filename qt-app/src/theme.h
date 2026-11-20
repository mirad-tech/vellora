// Design tokens lifted from the legacy stylesheet (:root in src/styles.css) so
// the native shell renders the same warm-grey surface, spacing and motion.
#pragma once

#include <QColor>
#include <QFont>
#include <QGuiApplication>
#include <QPalette>
#include <QString>
#include <QStyleHints>
#include <QVariant>

namespace theme {

inline bool isDark() {
  if (QGuiApplication::instance() == nullptr) return false;
#ifdef VELLORA_THEME_TEST_HOOKS
  const QVariant override = QGuiApplication::instance()->property("velloraTestDark");
  if (override.isValid()) return override.toBool();
#endif
  const QStyleHints* hints = QGuiApplication::styleHints();
  return hints != nullptr && hints->colorScheme() == Qt::ColorScheme::Dark;
}

inline QColor pick(const QColor& light, const QColor& dark) {
  return isDark() ? dark : light;
}

inline QString rgbaCss(const QColor& colour) {
  return QStringLiteral("rgba(%1,%2,%3,%4)")
      .arg(colour.red())
      .arg(colour.green())
      .arg(colour.blue())
      .arg(QString::number(colour.alphaF(), 'f', 3));
}

inline QColor bg() { return pick(QColor("#f9f9f7"), QColor("#181817")); }
inline QColor surface() { return pick(QColor("#fcfcfb"), QColor("#1e1e1c")); }
inline QColor raised() { return pick(QColor("#ffffff"), QColor("#262624")); }
inline QColor text() { return pick(QColor("#0b0b0b"), QColor("#ededeb")); }
inline QColor muted() { return pick(QColor("#52514e"), QColor("#a3a29e")); }
inline QColor faint() { return pick(QColor("#898781"), QColor("#767570")); }
inline QColor disabled() { return pick(QColor("#b6b5b2"), QColor("#5c5b57")); }
inline QColor primaryHover() { return pick(QColor("#2c2c2a"), QColor("#d8d8d4")); }
inline QColor accent() { return pick(QColor("#184f95"), QColor("#6cb0f5")); }
inline QColor linkUnderline() { return pick(QColor("#86b6ef"), QColor("#3b6ea5")); }
inline QColor focusRing() { return pick(QColor("#2a78d6"), QColor("#5aa3f0")); }
inline QColor codeBg() { return pick(QColor("#f3f3f0"), QColor("#292926")); }
// Vellora-specific warm selection, not an official Claude brand token. Search hits
// deliberately retain their separate hit()/searchCurrentBg() colours.
inline QColor selectionBg() { return pick(QColor("#e8d8c8"), QColor("#4a3b2e")); }
inline QColor selectionText() { return text(); }
inline QPalette selectionPalette(QPalette palette) {
  for (auto group : {QPalette::Active, QPalette::Inactive, QPalette::Disabled}) {
    palette.setColor(group, QPalette::Highlight, selectionBg());
    palette.setColor(group, QPalette::HighlightedText, selectionText());
  }
  return palette;
}
inline QColor searchCurrentBg() { return pick(QColor("#9a4f35"), QColor("#a84f32")); }
inline QColor searchCurrentText() { return QColor("#ffffff"); }
inline QColor hit() { return pick(QColor("#f3e6bd"), QColor("#594a21")); }
inline QColor danger() { return pick(QColor("#bd503f"), QColor("#e57363")); }
inline QColor dangerText() { return pick(QColor("#a33125"), QColor("#f08070")); }
inline QColor dangerBg() { return pick(QColor("#faeeeb"), QColor("#3b2220")); }
inline QColor dangerBgHover() { return pick(QColor("#f5dfd9"), QColor("#4b2b28")); }

inline QColor border() { return pick(QColor(11, 11, 11, 26), QColor(240, 240, 236, 28)); }
inline QColor borderStrong() { return pick(QColor(11, 11, 11, 51), QColor(240, 240, 236, 56)); }
inline QColor hover() { return pick(QColor(11, 11, 11, 13), QColor(240, 240, 236, 18)); }
inline QColor pressed() { return pick(QColor(11, 11, 11, 23), QColor(240, 240, 236, 30)); }
inline QColor scrollbarThumb() { return pick(QColor(11, 11, 11, 51), QColor(240, 240, 236, 56)); }
inline QColor scrollbarThumbHover() { return pick(QColor(11, 11, 11, 89), QColor(240, 240, 236, 97)); }
inline QColor codeScrollTrack() { return pick(QColor(11, 11, 11, 16), QColor(240, 240, 236, 20)); }
inline QColor codeScrollThumb() { return pick(QColor(11, 11, 11, 70), QColor(240, 240, 236, 76)); }
inline QColor scrim() { return pick(QColor(11, 11, 11, 61), QColor(0, 0, 0, 128)); }
inline QColor shadowColor() { return pick(QColor(0, 0, 0, 40), QColor(0, 0, 0, 120)); }
inline QColor modalShadowColor() { return pick(QColor(0, 0, 0, 48), QColor(0, 0, 0, 160)); }

inline QPalette appPalette(QPalette palette = QPalette()) {
  const bool dark = isDark();
  const QColor window = bg();
  const QColor base = raised();
  const QColor fg = text();
  const QColor dis = disabled();
  const QColor mid = dark ? QColor("#363633") : QColor("#d9d9d5");
  const QColor darkRole = dark ? QColor("#2f2f2c") : QColor("#c9c8c4");
  const QColor lightRole = dark ? QColor("#32322f") : QColor("#ffffff");
  for (auto group : {QPalette::Active, QPalette::Inactive, QPalette::Disabled}) {
    const QColor textColour = group == QPalette::Disabled ? dis : fg;
    palette.setColor(group, QPalette::Window, window);
    palette.setColor(group, QPalette::WindowText, textColour);
    palette.setColor(group, QPalette::Base, base);
    palette.setColor(group, QPalette::AlternateBase, window);
    palette.setColor(group, QPalette::Text, textColour);
    palette.setColor(group, QPalette::Button, base);
    palette.setColor(group, QPalette::ButtonText, textColour);
    palette.setColor(group, QPalette::BrightText, searchCurrentText());
    palette.setColor(group, QPalette::PlaceholderText, faint());
    palette.setColor(group, QPalette::ToolTipBase, base);
    palette.setColor(group, QPalette::ToolTipText, fg);
    palette.setColor(group, QPalette::Link, accent());
    palette.setColor(group, QPalette::LinkVisited, accent());
    palette.setColor(group, QPalette::Light, lightRole);
    palette.setColor(group, QPalette::Midlight, dark ? QColor("#2c2c29") : QColor("#f3f3f0"));
    palette.setColor(group, QPalette::Mid, mid);
    palette.setColor(group, QPalette::Dark, darkRole);
    palette.setColor(group, QPalette::Shadow, dark ? QColor("#0c0c0b") : QColor("#898781"));
  }
  return selectionPalette(palette);
}

inline int radiusControl() { return 8; }
inline int radiusGroup() { return 12; }
inline int radiusSearch() { return 14; }
inline int radiusFloating() { return 16; }

inline int toolbarHeight() { return 52; }
inline int controlHeight() { return 32; }
inline int controlHeightCompact() { return 28; }
inline int searchWidth() { return 360; }
inline int documentMaxWidth() { return 800; }
inline int documentPaddingInline() { return 32; }

inline QString uiFamily() {
  return QStringLiteral("Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI");
}

inline QString monoFamily() {
  return QStringLiteral("Cascadia Code, Consolas, Microsoft YaHei UI");
}

inline QFont uiFont(int pixelSize = 14, int weight = QFont::Normal) {
  QFont font;
  // Windows exposes the optical-size family as "Segoe UI Variable Text" to
  // DirectWrite, but Qt's database only knows the base family. Listing the base
  // family first is what keeps the metrics identical to the legacy stylesheet.
  font.setFamilies({QStringLiteral("Segoe UI Variable"), QStringLiteral("Segoe UI Variable Text"),
                    QStringLiteral("Segoe UI"), QStringLiteral("Microsoft YaHei UI")});
  font.setPixelSize(pixelSize);
  font.setWeight(static_cast<QFont::Weight>(weight));
  font.setHintingPreference(QFont::PreferDefaultHinting);
  return font;
}

inline QFont monoFont(int pixelSize = 14) {
  QFont font;
  font.setFamilies({QStringLiteral("Cascadia Code"), QStringLiteral("Consolas"),
                    QStringLiteral("Microsoft YaHei UI")});
  font.setPixelSize(pixelSize);
  return font;
}

}  // namespace theme
