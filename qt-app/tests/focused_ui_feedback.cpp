#include <QtWidgets>
#include <QtTest>
#include "chrome.h"
#include "source_view.h"
#include "theme.h"

class FocusedUiFeedback : public QObject {
  Q_OBJECT
  static int darkPixels(const QImage& image, const QRect& area) {
    int count = 0;
    const qreal ratio = image.devicePixelRatio();
    const QRect pixels(qRound(area.x() * ratio), qRound(area.y() * ratio),
                       qRound(area.width() * ratio), qRound(area.height() * ratio));
    const QRect bounded = pixels.intersected(image.rect());
    for (int y = bounded.top(); y <= bounded.bottom(); ++y)
      for (int x = bounded.left(); x <= bounded.right(); ++x) {
        const QColor colour = image.pixelColor(x, y);
        if (colour.red() < 180 && colour.green() < 180 && colour.blue() < 180) ++count;
      }
    return count;
  }
  static QRect sliderRect(QScrollBar* bar) {
    QStyleOptionSlider option; option.initFrom(bar); option.orientation = Qt::Vertical;
    option.minimum = bar->minimum(); option.maximum = bar->maximum(); option.pageStep = bar->pageStep();
    option.sliderPosition = bar->sliderPosition(); option.sliderValue = bar->value();
    return bar->style()->subControlRect(QStyle::CC_ScrollBar, &option, QStyle::SC_ScrollBarSlider, bar);
  }
  static void verifyInsetThumbAndDrag(QScrollBar* bar) {
    bar->setValue(0); QCoreApplication::processEvents();
    const QRect thumb = sliderRect(bar); QVERIFY(!thumb.isEmpty());
    const QImage image = bar->grab().toImage(); const qreal dpr = image.devicePixelRatio();
    const int y = qRound(thumb.center().y() * dpr); int first = image.width(), last = -1;
    for (int x = 0; x < image.width(); ++x) {
      const QColor colour = image.pixelColor(x, y);
      if (colour.alpha() > 0 && colour.red() < 230 && colour.green() < 230 && colour.blue() < 230) {
        first = qMin(first, x); last = qMax(last, x);
      }
    }
    QVERIFY2(last >= first, "Scrollbar thumb must have visible pixels");
    QVERIFY(first / dpr >= 4); QVERIFY(qAbs((image.width() - 1 - last) / dpr - 1) <= 1);
    const QPoint grab(7, thumb.center().y());
    QTest::mousePress(bar, Qt::LeftButton, Qt::NoModifier, grab);
    QTest::mouseMove(bar, QPoint(7, bar->height() - 20), 20);
    QTest::mouseRelease(bar, Qt::LeftButton, Qt::NoModifier, QPoint(7, bar->height() - 20));
    QVERIFY(bar->value() > 0);
    QTest::keyClick(bar, Qt::Key_Home); QCOMPARE(bar->value(), bar->minimum());
    QTest::keyClick(bar, Qt::Key_End); QCOMPARE(bar->value(), bar->maximum());
  }
 private slots:
  void softSelectionIsConsistentWithoutChangingSearchColours() {
    QCOMPARE(theme::selectionBg(), QColor("#d6e6f5"));
    QCOMPARE(theme::selectionText(), QColor("#0b0b0b"));
    QVERIFY(theme::selectionBg() != theme::hit());
    QVERIFY(theme::selectionBg() != theme::accent());
    QCOMPARE(theme::hit(), QColor("#e4effb"));
    QCOMPARE(theme::accent(), QColor("#184f95"));
    SourceView source; source.setMarkdown("Selected text"); source.ensurePolished();
    source.selectAll();
    QCOMPARE(source.textCursor().selectedText(), QString("Selected text"));
    QVERIFY(!source.document()->isUndoAvailable());
    SearchPanel search; search.ensurePolished();
    const auto inputs = search.findChildren<QLineEdit*>(); QCOMPARE(inputs.size(), 2);
    QList<QWidget*> targets{&source};
    for (auto* input : inputs) { input->ensurePolished(); targets.append(input); }
    for (auto* widget : targets) {
      for (auto group : {QPalette::Active, QPalette::Inactive, QPalette::Disabled}) {
        QCOMPARE(widget->palette().color(group, QPalette::Highlight), theme::selectionBg());
        QCOMPARE(widget->palette().color(group, QPalette::HighlightedText), theme::selectionText());
      }
    }
    const QPalette base;
    const auto soft = theme::selectionPalette(base);
    QCOMPARE(soft.color(QPalette::Base), base.color(QPalette::Base));
    QCOMPARE(soft.color(QPalette::Text), base.color(QPalette::Text));
  }

  void sourceCurrentSearchSurvivesNativeSelection() {
    SourceView source; source.resize(640, 240); source.show(); source.setFocus();
    const QString original = QStringLiteral("FIND FIND"); source.setMarkdown(original);
    auto range = [&](int start, int end) {
      QTextCursor cursor(source.document()); cursor.setPosition(start);
      cursor.setPosition(end, QTextCursor::KeepAnchor); return cursor;
    };
    auto matches = [&](bool second) {
      QList<QTextEdit::ExtraSelection> selections;
      for (int i = 0; i < 2; ++i) {
        QTextEdit::ExtraSelection hit; hit.cursor = range(i * 5, i * 5 + 4);
        hit.format.setBackground(i == int(second) ? theme::accent() : theme::hit());
        if (i == int(second)) hit.format.setForeground(theme::surface());
        selections.append(hit);
      }
      source.setExtraSelections(selections);
    };
    auto verifyActive = [&] {
      QCoreApplication::processEvents();
      for (auto group : {QPalette::Active, QPalette::Inactive, QPalette::Disabled}) {
        QCOMPARE(source.palette().color(group, QPalette::Highlight), theme::accent());
        QCOMPARE(source.palette().color(group, QPalette::HighlightedText), theme::surface());
      }
      const QImage image = source.viewport()->grab().toImage();
      int active = 0, passive = 0;
      for (int y = 0; y < image.height(); ++y)
        for (int x = 0; x < image.width(); ++x) {
          active += image.pixelColor(x, y) == theme::accent();
          passive += image.pixelColor(x, y) == theme::hit();
        }
      QVERIFY(active > 50); QVERIFY(passive > 50);
    };
    matches(false); source.setTextCursor(range(0, 4)); verifyActive();
    matches(true); source.setTextCursor(range(5, 9)); verifyActive();
    source.setTextCursor(range(1, 3));
    QCOMPARE(source.palette().color(QPalette::Highlight), theme::selectionBg());
    QCOMPARE(source.palette().color(QPalette::HighlightedText), theme::selectionText());
    source.setTextCursor(range(5, 9)); verifyActive();
    source.setExtraSelections({});
    QCOMPARE(source.selectedText(), QStringLiteral("FIND"));
    QCOMPARE(source.palette().color(QPalette::Highlight), theme::selectionBg());
    QCOMPARE(source.palette().color(QPalette::HighlightedText), theme::selectionText());
    QCOMPARE(source.markdown(), original);
    QVERIFY(!source.document()->isModified()); QVERIFY(!source.document()->isUndoAvailable());
  }

  void modalBackgroundSurvivesConflictIdentity_data() {
    QTest::addColumn<QString>("identity");
    QTest::newRow("ordinary") << QStringLiteral("modal");
    QTest::newRow("conflict") << QStringLiteral("conflictModal");
  }
  void modalBackgroundSurvivesConflictIdentity() {
    QFETCH(QString, identity);
    QWidget host; host.resize(800, 600); host.setAutoFillBackground(true);
    QPalette palette = host.palette(); palette.setColor(QPalette::Window, QColor("#667788"));
    host.setPalette(palette); host.show();
    ModalDialog dialog(&host, "Title", "Message", "Confirm", "Cancel");
    dialog.setObjectName(identity); dialog.setGraphicsEffect(nullptr);
    dialog.move(50, 50); dialog.show(); QCoreApplication::processEvents();
    const QImage image = dialog.grab().toImage();
    const qreal dpr = image.devicePixelRatio();
    QCOMPARE(image.pixelColor(qRound(12 * dpr), qRound(40 * dpr)), theme::raised());
  }

  void sourceViewportReachesBottom_data() {
    QTest::addColumn<int>("width");
    for (int width : {640, 820, 1280}) QTest::newRow(qPrintable(QString::number(width))) << width;
  }
  void sourceViewportReachesBottom() {
    QFETCH(int, width);
    SourceView view; view.resize(width, 600); view.show();
    const QString text = QStringLiteral("a source line\n").repeated(200);
    view.setMarkdown(text); QCoreApplication::processEvents();
    QSignalSpy changed(&view, &QPlainTextEdit::textChanged);
    QCOMPARE(view.viewport()->geometry().bottom(), view.height() - 1);
    const int layoutWidth = width - view.verticalScrollBar()->width();
    QCOMPARE(view.viewport()->width(), qMin(800, layoutWidth) - (width < 760 ? 40 : 64));
    view.revealOffset(0);
    QCOMPARE(view.viewport()->mapTo(&view, view.cursorRect().topLeft()).y(), 24);
    QCOMPARE(view.viewport()->geometry().bottom(), view.height() - 1);
    QTest::keyClick(&view, Qt::Key_End, Qt::ControlModifier);
    QVERIFY(view.cursorRect().bottom() <= view.viewport()->height());
    QCOMPARE(view.markdown(), text); QCOMPARE(changed.count(), 0);
    QVERIFY(!view.document()->isUndoAvailable());
  }
  void surfaceReopenAndSearchExpansion() {
    QWidget host; host.resize(820, 600); host.show();
    SearchPanel panel(&host); panel.move(440, 8); panel.openWith(false);
    const QPoint origin = panel.pos();
    auto* entrance = panel.graphicsEffect()->findChild<QVariantAnimation*>("surfaceEnterAnimation");
    QVERIFY(entrance); QCOMPARE(entrance->duration(), 200);
    auto* query = panel.findChild<QLineEdit*>(); QVERIFY(query);
    auto* row = panel.findChild<QWidget*>("navigationRow"); QVERIFY(row);
    QTest::keyClicks(query, "query");
    QTRY_COMPARE_WITH_TIMEOUT(row->height(), 32, 1000);
    QCOMPARE(QApplication::focusWidget(), static_cast<QWidget*>(query));
    query->clear(); QTest::qWait(20); QTest::keyClicks(query, "again");
    QTRY_COMPARE_WITH_TIMEOUT(row->height(), 32, 1000); QVERIFY(row->isVisible());
    panel.setReplaceVisible(true);
    auto* replacement = panel.findChild<QWidget*>("replacementRow"); QVERIFY(replacement->isVisible());
    QVERIFY(!replacement->graphicsEffect()); QVERIFY(!row->graphicsEffect());
    panel.closePanel(); QVERIFY(!panel.isVisible());
    QCOMPARE(entrance->state(), QAbstractAnimation::Stopped);
    panel.openWith(false); panel.closePanel(); panel.openWith(false);
    QTRY_COMPARE_WITH_TIMEOUT(entrance->state(), QAbstractAnimation::Stopped, 1000);
    QCOMPARE(panel.pos(), origin); QCOMPARE(panel.query(), QStringLiteral("again"));
    QTest::keyClicks(query, "continued"); QCOMPARE(panel.query(), QStringLiteral("continued"));
    query->clear(); QTRY_VERIFY_WITH_TIMEOUT(!row->isVisible(), 1000);
  }
  void searchRowsHaveVisibleCompositedPixels() {
    QWidget host; host.resize(820, 600); host.show();
    SearchPanel panel(&host); panel.move(440, 8); panel.openWith(false);
    auto* query = panel.findChild<QLineEdit*>(); QVERIFY(query);
    query->setText("Visible query"); panel.setCounter(1, 8);
    auto* row = panel.findChild<QWidget*>("navigationRow"); QVERIFY(row);
    QTRY_COMPARE_WITH_TIMEOUT(row->height(), 32, 1000);
    QTest::qWait(250);
    auto pixels = host.grab().toImage();
    QPoint origin = row->mapTo(&host, QPoint());
    QVERIFY2(darkPixels(pixels, QRect(origin + QPoint(12, 6), QSize(52, 20))) > 8,
             "Search navigation arrows must render through the parent effect");
    auto* counter = row->findChild<QLabel*>(); QVERIFY(counter);
    QVERIFY(counter->text().contains('1') && counter->text().contains('8'));
    const QRect counterArea(counter->mapTo(&host, QPoint()), counter->size());
    QVERIFY2(darkPixels(pixels, counterArea.adjusted(0, 3, 0, -3)) > 8,
             "Search match count must be visibly painted, not only exposed to accessibility");
    panel.setReplaceVisible(true);
    auto* replacement = panel.findChild<QWidget*>("replacementRow"); QVERIFY(replacement);
    auto* input = replacement->findChild<QLineEdit*>(); QVERIFY(input); input->setText("ReplacementVisible");
    QTest::qWait(250); pixels = host.grab().toImage();
    origin = input->mapTo(&host, QPoint());
    QVERIFY2(darkPixels(pixels, QRect(origin + QPoint(2, 8), QSize(qMin(160, input->width() - 4), 24))) > 20,
             "Replacement input text must be visible in the composited host screenshot");
    panel.closePanel(); panel.openWith(true); panel.setCounter(1, 8);
    QTest::qWait(250); pixels = host.grab().toImage(); origin = input->mapTo(&host, QPoint());
    QVERIFY(darkPixels(pixels, QRect(origin + QPoint(2, 8), QSize(qMin(160, input->width() - 4), 24))) > 20);
  }
  void outlineScrollbarAndRapidReopen() {
    QWidget host; host.resize(820, 600); host.show();
    OutlinePanel panel(&host); panel.setFloating(true); panel.setGeometry(12, 8, 248, 500);
    QJsonArray headings;
    for (int i = 0; i < 100; ++i) headings.append(QJsonObject{{"level", 1}, {"text", QString::number(i)}});
    panel.setHeadings(headings); panel.show();
    auto* entrance = panel.graphicsEffect()->findChild<QVariantAnimation*>("surfaceEnterAnimation"); QVERIFY(entrance);
    const QRect geometry = panel.geometry();
    panel.hide(); panel.show(); panel.hide(); panel.show();
    QTRY_COMPARE_WITH_TIMEOUT(entrance->state(), QAbstractAnimation::Stopped, 1000);
    QCOMPARE(panel.geometry(), geometry);
    auto* area = panel.findChild<QScrollArea*>(); QVERIFY(area);
    auto* bar = area->verticalScrollBar(); QVERIFY(bar->maximum() > 0); QCOMPARE(bar->width(), 10);
    const int trackRight = bar->mapTo(&panel, bar->rect().bottomRight()).x();
    QVERIFY(panel.width() - 1 - trackRight >= 1);
    QVERIFY(panel.width() - 1 - trackRight <= 2);
    QVERIFY(bar->mapTo(&panel, bar->rect().bottomRight()).y() <= panel.height() - 12);
    verifyInsetThumbAndDrag(bar);
    QStyleOptionSlider option; option.initFrom(bar); option.orientation = Qt::Vertical;
    option.minimum = bar->minimum(); option.maximum = bar->maximum(); option.pageStep = bar->pageStep();
    QCOMPARE(bar->style()->subControlRect(QStyle::CC_ScrollBar, &option, QStyle::SC_ScrollBarAddLine, bar).height(), 0);
    QCOMPARE(bar->style()->subControlRect(QStyle::CC_ScrollBar, &option, QStyle::SC_ScrollBarSubLine, bar).height(), 0);
    bar->setValue(bar->maximum()); QVERIFY(!panel.grab().isNull());
    panel.setFloating(false); QCoreApplication::processEvents();
    const int dockGap = panel.width() - 1 - bar->mapTo(&panel, bar->rect().bottomRight()).x();
    QVERIFY(dockGap >= 1 && dockGap <= 2);
    verifyInsetThumbAndDrag(bar);
  }
  void sourceScrollbarAtInsideEdgeRemainsInteractive() {
    SourceView view; view.resize(820, 600); view.show();
    const QString original = QStringLiteral("source line\n").repeated(400);
    view.setMarkdown(original); QCoreApplication::processEvents();
    auto* bar = view.verticalScrollBar(); QVERIFY(bar->maximum() > 0);
    QCOMPARE(bar->mapTo(&view, bar->rect().bottomRight()).x(), view.width() - 1);
    QSignalSpy changed(&view, &QPlainTextEdit::textChanged);
    verifyInsetThumbAndDrag(bar);
    QCOMPARE(view.markdown(), original); QCOMPARE(changed.count(), 0);
    QVERIFY(!view.document()->isUndoAvailable());
  }
  void saveIconAndLabelAreCentredAndStillActivate() {
    Toolbar toolbar; toolbar.resize(820, 52); toolbar.setDocumentAvailable(true);
    toolbar.setDocumentName("test.md", "", true); toolbar.setSaveEnabled(true); toolbar.show();
    QCoreApplication::processEvents();
    QToolButton* save = nullptr;
    for (auto* button : toolbar.findChildren<QToolButton*>()) if (button->text() == QStringLiteral("保存")) save = button;
    QVERIFY(save); QCOMPARE(save->size(), QSize(72, 32));
    const QImage image = save->grab().toImage(); int left = image.width(), right = -1;
    for (int y = 8; y < 24; ++y) for (int x = 8; x < image.width() - 8; ++x) {
      const QColor colour = image.pixelColor(x, y);
      if (colour.red() > 200 && colour.green() > 200 && colour.blue() > 200) { left = qMin(left, x); right = qMax(right, x); }
    }
    QVERIFY(right >= left); QVERIFY2(qAbs((left + right) / 2.0 - (image.width() - 1) / 2.0) <= 2,
                                      qPrintable(QString("Content ink spans %1..%2").arg(left).arg(right)));
    QSignalSpy requested(&toolbar, &Toolbar::saveRequested); save->setFocus();
    QTest::keyClick(save, Qt::Key_Space); QCOMPARE(requested.count(), 1);
  }
};
QTEST_MAIN(FocusedUiFeedback)
#include "focused_ui_feedback.moc"
