// Design tokens lifted from the legacy stylesheet (:root in src/styles.css) so
// the native shell renders the same warm-grey surface, spacing and motion.
#pragma once

#include <QColor>
#include <QFont>
#include <QPalette>
#include <QString>

namespace theme {

inline QColor bg() { return QColor("#f9f9f7"); }
inline QColor surface() { return QColor("#fcfcfb"); }
inline QColor raised() { return QColor("#ffffff"); }
inline QColor text() { return QColor("#0b0b0b"); }
inline QColor muted() { return QColor("#52514e"); }
inline QColor faint() { return QColor("#898781"); }
inline QColor accent() { return QColor("#184f95"); }
inline QColor focusRing() { return QColor("#2a78d6"); }
inline QColor codeBg() { return QColor("#f3f3f0"); }
// Vellora-specific warm selection, not an official Claude brand token. Search hits
// deliberately retain their separate hit()/searchCurrentBg() colours.
inline QColor selectionBg() { return QColor("#e8d8c8"); }
inline QColor selectionText() { return text(); }
inline QPalette selectionPalette(QPalette palette) {
  for (auto group : {QPalette::Active, QPalette::Inactive, QPalette::Disabled}) {
    palette.setColor(group, QPalette::Highlight, selectionBg());
    palette.setColor(group, QPalette::HighlightedText, selectionText());
  }
  return palette;
}
inline QColor searchCurrentBg() { return QColor("#9a4f35"); }
inline QColor searchCurrentText() { return QColor("#ffffff"); }
inline QColor hit() { return QColor("#f3e6bd"); }
inline QColor danger() { return QColor("#bd503f"); }
inline QColor dangerBg() { return QColor("#faeeeb"); }

inline QColor border() { return QColor(11, 11, 11, 26); }        // 10%
inline QColor borderStrong() { return QColor(11, 11, 11, 51); }   // 20%
inline QColor hover() { return QColor(11, 11, 11, 13); }          // 5%
inline QColor pressed() { return QColor(11, 11, 11, 23); }        // 9%

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
