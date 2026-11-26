#include <QtWidgets>
#include <QtTest>
#include <cmath>

#include "bridge.h"
#include "chrome.h"
#include "code_highlight.h"
#include "document_view.h"
#include "main_window.h"
#include "source_view.h"
#include "theme.h"

namespace {

double relativeLuminance(const QColor& colour) {
  auto channel = [](double value) {
    return value <= 0.03928 ? value / 12.92 : std::pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(colour.redF()) + 0.7152 * channel(colour.greenF()) +
         0.0722 * channel(colour.blueF());
}

double contrastRatio(const QColor& a, const QColor& b) {
  const double l1 = relativeLuminance(a);
  const double l2 = relativeLuminance(b);
  return (qMax(l1, l2) + 0.05) / (qMin(l1, l2) + 0.05);
}

int countColour(const QImage& image, const QColor& target) {
  int count = 0;
  for (int y = 0; y < image.height(); ++y) {
    for (int x = 0; x < image.width(); ++x) {
      if (image.pixelColor(x, y) == target) ++count;
    }
  }
  return count;
}

// Link text is thin and anti-aliased, so how many pixels land on the exact
// accent colour depends on the platform's fonts and rasteriser (Ubuntu 24.04
// arm64 renders far fewer than Windows or Debian). Count pixels within a small
// per-channel tolerance of the accent instead; the light and dark accents are
// far apart, so this still tells which palette the links were drawn with.
int countNearColour(const QImage& image, const QColor& target, int tolerance = 40) {
  int count = 0;
  for (int y = 0; y < image.height(); ++y) {
    for (int x = 0; x < image.width(); ++x) {
      const QColor c = image.pixelColor(x, y);
      if (qAbs(c.red() - target.red()) <= tolerance &&
          qAbs(c.green() - target.green()) <= tolerance &&
          qAbs(c.blue() - target.blue()) <= tolerance)
        ++count;
    }
  }
  return count;
}

QByteArray accentCounts(const QImage& image) {
  return QStringLiteral("exact accent pixels: %1, near accent pixels: %2")
      .arg(countColour(image, theme::accent()))
      .arg(countNearColour(image, theme::accent()))
      .toUtf8();
}

void setScheme(Qt::ColorScheme scheme) {
  qApp->setProperty("velloraTestDark", scheme == Qt::ColorScheme::Dark);
  if (auto* hints = QGuiApplication::styleHints()) {
    hints->setColorScheme(scheme);
    QMetaObject::invokeMethod(hints, "colorSchemeChanged", Qt::DirectConnection,
                              Q_ARG(Qt::ColorScheme, scheme));
  }
  QCoreApplication::processEvents();
}

}  // namespace

class ThemeRegressions : public QObject {
  Q_OBJECT
  QTemporaryDir files_;

  QString fixture(const QByteArray& content, const QString& name = QStringLiteral("theme.md")) {
    const QString path = files_.filePath(name);
    QFile file(path);
    if (file.open(QIODevice::WriteOnly)) file.write(content);
    return path;
  }

 private slots:
  void initTestCase() { QVERIFY(files_.isValid()); }
  void cleanup() {
    qApp->setProperty("velloraTestDark", QVariant());
    if (auto* hints = QGuiApplication::styleHints()) {
      hints->unsetColorScheme();
    }
    QCoreApplication::processEvents();
  }

  void darkAndLightTokensHaveDistinctAccessiblePalettes() {
    setScheme(Qt::ColorScheme::Light);
    QVERIFY(!theme::isDark());
    const QColor lightBg = theme::bg();
    const QColor lightSurface = theme::surface();
    const QColor lightRaised = theme::raised();
    const QColor lightText = theme::text();
    const QColor lightSelection = theme::selectionBg();

    setScheme(Qt::ColorScheme::Dark);
    QVERIFY(theme::isDark());
    QCOMPARE(theme::bg(), QColor("#181817"));
    QCOMPARE(theme::surface(), QColor("#1e1e1c"));
    QCOMPARE(theme::raised(), QColor("#262624"));
    QCOMPARE(theme::text(), QColor("#ededeb"));
    QVERIFY(theme::bg() != lightBg);
    QVERIFY(theme::surface() != lightSurface);
    QVERIFY(theme::raised() != lightRaised);
    QVERIFY(theme::text() != lightText);
    QVERIFY(theme::selectionBg() != lightSelection);
    QVERIFY(theme::selectionBg() != theme::hit());
    QVERIFY(theme::selectionBg() != theme::searchCurrentBg());

    // WCAG AA readability checks in dark mode.
    QVERIFY(contrastRatio(theme::text(), theme::surface()) >= 12.0);
    QVERIFY(contrastRatio(theme::muted(), theme::surface()) >= 4.5);
    QVERIFY(contrastRatio(theme::accent(), theme::surface()) >= 4.5);
    QVERIFY(contrastRatio(theme::selectionText(), theme::selectionBg()) >= 4.5);
    QVERIFY(contrastRatio(theme::text(), theme::hit()) >= 4.5);
    QVERIFY(contrastRatio(theme::searchCurrentText(), theme::searchCurrentBg()) >= 4.5);
    QVERIFY(contrastRatio(theme::danger(), theme::dangerBg()) >= 4.5);
    QVERIFY(contrastRatio(theme::dangerText(), theme::dangerBg()) >= 4.5);
  }

  void darkColdStartRendersChromeAndViews() {
    setScheme(Qt::ColorScheme::Dark);
    const QString markdown = QStringLiteral(
        "# Dark Heading\n\n"
        "Body paragraph with `code` and [link](https://example.com) and ![missing](nope.png).\n\n"
        "> Quoted text with [quoted link](https://example.com).\n\n"
        "```ts\nconst answer = 42;\n```\n");
    const QString path = fixture(markdown.toUtf8(), QStringLiteral("dark-cold.md"));

    MainWindow window;
    window.resize(960, 760);
    window.show();
    window.openPath(path);
    QTRY_VERIFY_WITH_TIMEOUT(!window.isAsyncBusy(), 5000);
    QCoreApplication::processEvents();

    auto* doc = window.findChild<DocumentView*>(QStringLiteral("documentView"));
    auto* toolbar = window.findChild<Toolbar*>();
    QVERIFY(doc);
    QVERIFY(toolbar);

    const QImage docImage = doc->viewport()->grab().toImage();
    QVERIFY(countColour(docImage, theme::surface()) > 5000);
    QVERIFY(countColour(docImage, theme::codeBg()) > 200);
    QVERIFY2(countNearColour(docImage, theme::accent()) > 20, accentCounts(docImage).constData());
    QVERIFY(countColour(docImage, theme::danger()) > 10);

    const QImage toolbarImage = toolbar->grab().toImage();
    QVERIFY(countColour(toolbarImage, theme::bg()) > 1000);

    // Search panel and outline panel follow dark raised/bg surfaces.
    window.openSearchPanel(false);
    QTest::qWait(250);
    auto* search = window.findChild<SearchPanel*>();
    QVERIFY(search && search->isVisible());
    const QImage searchImage = search->grab().toImage();
    QVERIFY(countColour(searchImage, theme::raised()) > 500);
  }

  void liveThemeSwitchUpdatesDocumentWithoutDirtyingOrClearingUndo() {
    setScheme(Qt::ColorScheme::Light);
    const QString original = QStringLiteral(
        "# Live Switch\n\n"
        "Editable paragraph with [Open documentation link](https://example.com).\n\n"
        "> Quote line\n\n"
        "```ts\nconst item = 1;\n```\n");
    const QString path = fixture(original.toUtf8(), QStringLiteral("live-switch.md"));

    DocumentView view;
    view.resize(820, 700);
    view.show();
    view.setPlan(bridge::planFor(original).value("plan").toObject(), path);
    QCoreApplication::processEvents();

    // Perform an edit so both pendingEdits and undo stack are populated.
    QVERIFY(view.revealText(QStringLiteral("Editable")));
    view.setFocus();
    QTest::keyClicks(&view, QStringLiteral("Edited"));
    QCoreApplication::processEvents();
    QVERIFY(view.hasPendingEdits());
    QVERIFY(view.document()->isUndoAvailable());
    const auto editsBefore = view.pendingEdits();
    const QString plainBefore = view.document()->toPlainText();

    const QImage lightImage = view.viewport()->grab().toImage();
    QVERIFY(countColour(lightImage, QColor("#fcfcfb")) > 5000);

    // Switch Light -> Dark while editing.
    setScheme(Qt::ColorScheme::Dark);
    const QImage darkImage = view.viewport()->grab().toImage();
    QVERIFY(countColour(darkImage, QColor("#1e1e1c")) > 5000);
    QCOMPARE(countColour(darkImage, QColor("#fcfcfb")), 0);
    QVERIFY(countColour(darkImage, theme::codeBg()) > 200);
    QVERIFY2(countNearColour(darkImage, theme::accent()) > 15, accentCounts(darkImage).constData());
    QCOMPARE(view.palette().color(QPalette::Text), theme::text());
    QCOMPARE(view.palette().color(QPalette::Highlight), theme::selectionBg());
    bool foundDarkLinkFormat = false;
    for (QTextBlock b = view.document()->begin(); b.isValid(); b = b.next()) {
      for (const auto& range : b.layout()->formats()) {
        if (range.format.foreground().color() == theme::accent()) {
          foundDarkLinkFormat = true;
          break;
        }
      }
    }
    QVERIFY(foundDarkLinkFormat);

    // Document state and undo history must be completely untouched.
    QCOMPARE(view.document()->toPlainText(), plainBefore);
    QCOMPARE(view.pendingEdits(), editsBefore);
    QVERIFY(view.document()->isUndoAvailable());

    // Switch Dark -> Light and verify undo still reverts the user's edit cleanly.
    setScheme(Qt::ColorScheme::Light);
    const QImage backLightImage = view.viewport()->grab().toImage();
    QVERIFY(countColour(backLightImage, QColor("#fcfcfb")) > 5000);
    QCOMPARE(view.pendingEdits(), editsBefore);

    QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier);
    QCoreApplication::processEvents();
    QVERIFY(!view.hasPendingEdits());
  }

  void liveThemeSwitchUpdatesSourceSearchAndModalDialog() {
    setScheme(Qt::ColorScheme::Light);
    const QString content = QStringLiteral("alpha beta alpha\n");
    const QString path = fixture(content.toUtf8(), QStringLiteral("source-switch.md"));

    MainWindow window;
    window.resize(820, 640);
    window.show();
    window.openPath(path, true);
    QTRY_VERIFY_WITH_TIMEOUT(!window.isAsyncBusy(), 5000);
    QCoreApplication::processEvents();

    auto* source = window.findChild<SourceView*>(QStringLiteral("sourceView"));
    QVERIFY(source && source->isVisible());
    window.openSearchPanel(false);
    auto* search = window.findChild<SearchPanel*>();
    auto* query = search->findChild<QLineEdit*>();
    QVERIFY(query);
    query->setText(QStringLiteral("alpha"));
    QCoreApplication::processEvents();

    QVERIFY(countColour(source->viewport()->grab().toImage(), QColor("#9a4f35")) > 30);
    QVERIFY(countColour(source->viewport()->grab().toImage(), QColor("#f3e6bd")) > 30);

    // Live switch to Dark updates SourceView background and search ExtraSelections.
    setScheme(Qt::ColorScheme::Dark);
    const QImage darkSource = source->viewport()->grab().toImage();
    QVERIFY(countColour(darkSource, QColor("#1e1e1c")) > 2000);
    QVERIFY(countColour(darkSource, QColor("#a84f32")) > 30);
    QVERIFY(countColour(darkSource, QColor("#594a21")) > 30);

    // ModalDialog updates its raised background immediately on colorSchemeChanged.
    ModalDialog dialog(&window, QStringLiteral("标题"), QStringLiteral("内容"),
                       QStringLiteral("确认"), QStringLiteral("取消"));
    dialog.setGraphicsEffect(nullptr);
    dialog.show();
    QCoreApplication::processEvents();
    const QImage darkModal = dialog.grab().toImage();
    const qreal dpr = darkModal.devicePixelRatio();
    QCOMPARE(darkModal.pixelColor(qRound(12 * dpr), qRound(40 * dpr)), QColor("#262624"));

    setScheme(Qt::ColorScheme::Light);
    const QImage lightModal = dialog.grab().toImage();
    QCOMPARE(lightModal.pixelColor(qRound(12 * dpr), qRound(40 * dpr)), QColor("#ffffff"));
  }

  void readingTextKeepsDesignedOutlinesAcrossThemes() {
    if (theme::legacyTextRendering()) QSKIP("VELLORA_TEXT_RENDERING=legacy keeps the old rendering");
    // Reading text from 14 px keeps the designed outline; interface text and
    // smaller reading text keep the default hinting.
    QCOMPARE(theme::bodyFont(16).hintingPreference(), QFont::PreferNoHinting);
    QCOMPARE(theme::bodyFont(14, QFont::DemiBold).hintingPreference(), QFont::PreferNoHinting);
    QCOMPARE(theme::monoFont(14).hintingPreference(), QFont::PreferNoHinting);
    QCOMPARE(theme::bodyFont(13).hintingPreference(), QFont::PreferDefaultHinting);
    QCOMPARE(theme::monoFont(13).hintingPreference(), QFont::PreferDefaultHinting);
    QCOMPARE(theme::uiFont(16).hintingPreference(), QFont::PreferDefaultHinting);
    QCOMPARE(theme::uiFont(13).hintingPreference(), QFont::PreferDefaultHinting);

    setScheme(Qt::ColorScheme::Light);
    const QString original = QStringLiteral(
        "# Rendering\n\nBody **bold** and `code` text.\n\n| A | B |\n| --- | --- |\n| cell | value |\n\n"
        "```ts\nconst item = 1;\n```\n");
    const QString path = fixture(original.toUtf8(), QStringLiteral("text-rendering.md"));
    DocumentView view;
    view.resize(820, 700);
    view.show();
    view.setPlan(bridge::planFor(original).value("plan").toObject(), path);
    QCoreApplication::processEvents();
    QCOMPARE(view.document()->defaultFont().hintingPreference(), QFont::PreferNoHinting);
    // Every text fragment of 14 px or more is reading text, code included.
    const auto readingFragmentsUnhinted = [&] {
      int checked = 0;
      for (QTextBlock block = view.document()->begin(); block.isValid(); block = block.next()) {
        for (auto it = block.begin(); !it.atEnd(); ++it) {
          const QFont font = it.fragment().charFormat().font();
          if (font.pixelSize() < 14) continue;
          if (font.hintingPreference() != QFont::PreferNoHinting) return false;
          ++checked;
        }
      }
      return checked > 3;
    };
    QVERIFY(readingFragmentsUnhinted());
    SourceView source;
    QCOMPARE(source.font().hintingPreference(), QFont::PreferNoHinting);

    // A theme switch changes colours only.
    setScheme(Qt::ColorScheme::Dark);
    QVERIFY(readingFragmentsUnhinted());
    QCOMPARE(source.font().hintingPreference(), QFont::PreferNoHinting);
    setScheme(Qt::ColorScheme::Light);
    QVERIFY(readingFragmentsUnhinted());
  }
};

QTEST_MAIN(ThemeRegressions)
#include "theme_regressions.moc"
