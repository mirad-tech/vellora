#include <QtWidgets>
#include <QtTest>
#include <QLocalSocket>
#include <QCryptographicHash>
#include <algorithm>
#include <cmath>
#include "bridge.h"
#include "code_highlight.h"
#include "image_decode.h"
#include "chrome.h"
#include "document_view.h"
#include "main_window.h"
#include "source_view.h"
#include "theme.h"

// Only public widget APIs, real key/input-method events and toolbar signals.
// No private/public macro: that changes MSVC symbol linkage and hides regressions.
class NativeRegressions : public QObject {
  Q_OBJECT
  QTemporaryDir files_;
  int sequence_ = 0;
  int dialogs_ = 0;
  QTimer cancelDialogs_;
  static QByteArray read(const QString& path) {
    QFile f(path); if (!f.open(QIODevice::ReadOnly)) return {}; return f.readAll();
  }
  QString fixture(const QByteArray& bytes) {
    const QString path = files_.filePath(QString::number(++sequence_) + ".md");
    QFile f(path); if (!f.open(QIODevice::WriteOnly) || f.write(bytes) != bytes.size()) qFatal("Cannot write isolated fixture");
    return path;
  }
  static DocumentView* doc(MainWindow& w) { return w.findChild<DocumentView*>(); }
  static SourceView* source(MainWindow& w) { return w.findChild<SourceView*>(); }
  static void mode(MainWindow& w, int value) { emit w.findChild<Toolbar*>()->modeChanged(value); QCoreApplication::processEvents(); }
  static void show(MainWindow& w, const QString& path) { w.show(); w.openPath(path); w.activateWindow(); QTest::qWait(20); }
  static void sourceAppend(MainWindow& w, const QString& marker) {
    mode(w, 1); source(w)->setFocus(); QTest::keyClick(source(w), Qt::Key_End, Qt::ControlModifier); QTest::keyClicks(source(w), marker);
  }
  static bool documentAppend(MainWindow& w, const QString& needle, const QString& marker) {
    auto* view = doc(w); if (!view->revealText(needle)) return false;
    view->setFocus(); QTest::keyClick(view, Qt::Key_Right); QTest::keyClicks(view, marker); return true;
  }
  static void save(MainWindow& w) { QTest::keyClick(&w, Qt::Key_S, Qt::ControlModifier); }
 private slots:
  void initTestCase() {
    QVERIFY(files_.isValid()); QApplication::setQuitOnLastWindowClosed(false);
    connect(&cancelDialogs_, &QTimer::timeout, this, [this] {
      for (auto* w : QApplication::allWidgets()) {
        auto* dialog = qobject_cast<ModalDialog*>(w);
        if (dialog && dialog->isVisible()) { ++dialogs_; QTest::keyClick(dialog, Qt::Key_Escape); }
      }
    }); cancelDialogs_.start(5);
  }
  void cleanup() { cancelDialogs_.start(5); QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete); }
  void unchangedSavePreservesBytes_data() {
    QTest::addColumn<QByteArray>("bytes");
    QTest::newRow("lf") << QByteArray("# Heading\n\nBody **bold** and `code`.\n\n- one\n- two\n");
    QTest::newRow("crlf-bom") << QByteArray("\xef\xbb\xbf# Heading\r\n\r\nBody  \r\nnext\r\n");
  }
  void unchangedSavePreservesBytes() {
    QFETCH(QByteArray, bytes); const auto path = fixture(bytes); MainWindow w; show(w, path);
    mode(w, 1); mode(w, 0); save(w); QCOMPARE(read(path), bytes);
  }
  void sourceDocumentSaveAndRoundtrip() {
    const auto path = fixture("# Heading\n\nBody\n"); MainWindow w; show(w, path);
    sourceAppend(w, "MARKER"); // deliberately before the old dirty debounce fires
    mode(w, 0); QVERIFY(doc(w)->document()->toPlainText().contains("MARKER"));
    mode(w, 1); QVERIFY(source(w)->markdown().contains("MARKER"));
    mode(w, 0); save(w); QVERIFY(read(path).contains("MARKER"));
    QCOMPARE(read(path).count("MARKER"), 1);
  }
  void dirtyCloseCancels_data() { QTest::addColumn<bool>("sourceMode"); QTest::newRow("source-immediate") << true; QTest::newRow("document") << false; }
  void dirtyCloseCancels() {
    QFETCH(bool, sourceMode); const QByteArray original("# Heading\n\nBody\n"); const auto path = fixture(original); MainWindow w; show(w, path);
    if (sourceMode) sourceAppend(w, "UNSAVED"); else QVERIFY(documentAppend(w, "Body", "UNSAVED"));
    const int before = dialogs_; QVERIFY(!w.close()); QVERIFY(dialogs_ > before); QVERIFY(w.isVisible()); QCOMPARE(read(path), original);
    mode(w, 1); QVERIFY(source(w)->markdown().contains("UNSAVED"));
  }
  void dirtyOpenCancels() {
    const auto a = fixture("# First\n\nBody\n"); const auto b = fixture("# Second\n"); MainWindow w; show(w, a);
    sourceAppend(w, "UNSAVED"); const int before = dialogs_; w.openPath(b); QVERIFY(dialogs_ > before);
    QVERIFY(source(w)->markdown().contains("UNSAVED")); QVERIFY(!source(w)->markdown().contains("Second"));
    save(w); QVERIFY(read(a).contains("UNSAVED")); QCOMPARE(read(b), QByteArray("# Second\n"));
  }
  void documentEditPreservesStructure_data() {
    QTest::addColumn<QByteArray>("bytes"); QTest::addColumn<QString>("needle"); QTest::addColumn<QByteArray>("expected");
    QTest::newRow("crlf-edit") << QByteArray("Body\r\n\r\nTail\r\n") << QString("Body") << QByteArray("BodyMARK\r\n\r\nTail\r\n");
    QTest::newRow("heading") << QByteArray("## Heading\n\nUntouched **bold**.\n") << QString("Heading") << QByteArray("## HeadingMARK\n\nUntouched **bold**.\n");
    QTest::newRow("list") << QByteArray("- First\n- Second\n\nUntouched.\n") << QString("First") << QByteArray("- FirstMARK\n- Second\n\nUntouched.\n");
    QTest::newRow("quote") << QByteArray("> Quote\n\nUntouched.\n") << QString("Quote") << QByteArray("> QuoteMARK\n\nUntouched.\n");
    QTest::newRow("ordered-list") << QByteArray("3. First\n4. Second\n") << QString("First") << QByteArray("3. FirstMARK\n4. Second\n");
    QTest::newRow("nested-list") << QByteArray("- First\n  - Child\n- Second\n") << QString("Child") << QByteArray("- First\n  - ChildMARK\n- Second\n");
    QTest::newRow("raw-neighbor") << QByteArray("Body\n\n~~~js\nlet x = 1;\n~~~\n\n[ref]: https://example.com\n") << QString("Body") << QByteArray("BodyMARK\n\n~~~js\nlet x = 1;\n~~~\n\n[ref]: https://example.com\n");
    QTest::newRow("task") << QByteArray("- [x] Task\n- [ ] Later\n") << QString("Task") << QByteArray("- [x] TaskMARK\n- [ ] Later\n");
    QTest::newRow("inline") << QByteArray("Body **bold** and [link](https://example.com).\n\nTail.\n") << QString("Body") << QByteArray("BodyMARK **bold** and [link](https://example.com).\n\nTail.\n");
  }
  void documentEditPreservesStructure() {
    QFETCH(QByteArray, bytes); QFETCH(QString, needle); QFETCH(QByteArray, expected);
    const auto path = fixture(bytes); MainWindow w; show(w, path); QVERIFY(documentAppend(w, needle, "MARK")); save(w); QCOMPARE(read(path), expected);
  }
  void documentUndoRedo() {
    const QByteArray original("# Heading\n\nBody\n"); const auto path = fixture(original); MainWindow w; show(w, path);
    QVERIFY(documentAppend(w, "Body", "X")); QVERIFY(doc(w)->hasPendingEdits());
    QTest::keyClick(doc(w), Qt::Key_Z, Qt::ControlModifier); QVERIFY(!doc(w)->document()->toPlainText().contains("BodyX"));
    QVERIFY(!doc(w)->hasPendingEdits());
    QTest::keyClick(doc(w), Qt::Key_Y, Qt::ControlModifier); QVERIFY(doc(w)->document()->toPlainText().contains("BodyX"));
    save(w); QCOMPARE(read(path), QByteArray("# Heading\n\nBodyX\n"));
  }
  void sourceUndoRedo() {
    const auto path = fixture("Body\n"); MainWindow w; show(w, path); sourceAppend(w, "X");
    QTest::keyClick(source(w), Qt::Key_Z, Qt::ControlModifier); QVERIFY(!source(w)->markdown().contains("X"));
    QTest::keyClick(source(w), Qt::Key_Y, Qt::ControlModifier); QVERIFY(source(w)->markdown().contains("X")); save(w); QVERIFY(read(path).contains("X"));
  }
  void searchNavigation() {
    const auto path = fixture("one target two target three target\n"); MainWindow w; show(w, path); w.openSearchPanel(false);
    auto* panel = w.findChild<SearchPanel*>(); const auto inputs = panel->findChildren<QLineEdit*>(); QVERIFY(!inputs.isEmpty());
    inputs.first()->setText("target"); QCOMPARE(doc(w)->searchMatchCount(), 3);
    const int initial = doc(w)->searchActiveIndex(); QVERIFY(initial >= 0);
    emit panel->navigateRequested(1); QCOMPARE(doc(w)->searchActiveIndex(), (initial + 1) % 3);
    emit panel->navigateRequested(1); QCOMPARE(doc(w)->searchActiveIndex(), (initial + 2) % 3);
    emit panel->navigateRequested(1); QCOMPARE(doc(w)->searchActiveIndex(), initial);
    emit panel->navigateRequested(-1); QCOMPARE(doc(w)->searchActiveIndex(), (initial + 2) % 3);
  }
  void documentReplaceAndUndo() {
    const auto path = fixture("# target\n\nA target and target.\n"); MainWindow w; show(w, path);
    doc(w)->setSearchQuery("target", true); QCOMPARE(doc(w)->searchMatchCount(), 3); doc(w)->focusSearchResult(0);
    QVERIFY(doc(w)->replaceCurrent("first")); QVERIFY(doc(w)->document()->toPlainText().contains("first"));
    QCOMPARE(doc(w)->replaceAll("last"), 2); save(w); QCOMPARE(read(path), QByteArray("# first\n\nA last and last.\n"));
    doc(w)->setFocus(); QTest::keyClick(doc(w), Qt::Key_Z, Qt::ControlModifier); save(w);
    QCOMPARE(read(path), QByteArray("# first\n\nA target and target.\n"));
  }
  void externalConflictCancelKeepsDraft() {
    const auto path = fixture("Body\n"); MainWindow w; show(w, path); sourceAppend(w, "DRAFT");
    QFile changed(path); QVERIFY(changed.open(QIODevice::WriteOnly)); QCOMPARE(changed.write("External\n"), qint64(9)); changed.close();
    const int before = dialogs_; save(w); QVERIFY(dialogs_ > before); QCOMPARE(read(path), QByteArray("External\n"));
    QVERIFY(source(w)->markdown().contains("DRAFT")); const int closeBefore = dialogs_; QVERIFY(!w.close()); QVERIFY(dialogs_ > closeBefore);
  }
  void saveThenUndoRemainsSaveable() {
    const QByteArray original("Body\n"); const auto path = fixture(original); MainWindow w; show(w, path);
    QVERIFY(documentAppend(w, "Body", "X")); save(w); QCOMPARE(read(path), QByteArray("BodyX\n"));
    doc(w)->setFocus(); QTest::keyClick(doc(w), Qt::Key_Z, Qt::ControlModifier); save(w); QCOMPARE(read(path), original);
  }
  void selectionAcrossStructuresCannotCorrupt() {
    const QByteArray original("# Heading\n\nBody\n\n```txt\nprotected\n```\n");
    const auto path = fixture(original); MainWindow w; show(w, path); auto* view = doc(w); view->setFocus();
    QTest::keyClick(view, Qt::Key_A, Qt::ControlModifier); QTest::keyClicks(view, "X"); save(w);
    // Continuous editing must replace the full mixed-block selection, with undo restoring it.
    QCOMPARE(read(path).trimmed(), QByteArray("X"));
    QTest::keyClick(view, Qt::Key_Z, Qt::ControlModifier); save(w); QCOMPARE(read(path), original);
  }
  void gifAdvancesVisiblePixelsWithoutEditing() {
    const auto path=fixture("![animation](animated.gif)\n");QFile gif(files_.filePath("animated.gif"));QVERIFY(gif.open(QIODevice::WriteOnly));
    const QByteArray bytes=QByteArray::fromBase64("R0lGODlhBAAEAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAABAAEAAAICQABCBxIsCCAgAAh+QQBCgABACwAAAAABAAEAIEAAP8AAAAAAAAAAAAICQABCBxIsCCAgAA7");QCOMPARE(gif.write(bytes),qint64(bytes.size()));gif.close();
    QImageReader reader(gif.fileName());QVERIFY(reader.supportsAnimation());QCOMPARE(reader.imageCount(),2);
    DocumentView view;view.resize(820,700);view.show();view.setPlan(bridge::planFor("![animation](animated.gif)\n\n"+QString("Paragraph\n\n").repeated(100)).value("plan").toObject(),path);
    auto colors=[&]{const QImage shot=view.viewport()->grab().toImage().convertToFormat(QImage::Format_RGB32);QPair<bool,bool> seen{false,false};for(int y=0;y<shot.height();++y){const QRgb* row=reinterpret_cast<const QRgb*>(shot.constScanLine(y));for(int x=0;x<shot.width();++x){seen.first|=qRed(row[x])>200&&qBlue(row[x])<50&&qGreen(row[x])<50;seen.second|=qBlue(row[x])>200&&qRed(row[x])<50&&qGreen(row[x])<50;}}return seen;};
    bool red=false,blue=false;for(int i=0;i<60&&!(red&&blue);++i){const auto seen=colors();red|=seen.first;blue|=seen.second;QTest::qWait(25);}QVERIFY(red);QVERIFY(blue);QVERIFY(view.pendingEdits().isEmpty());
    view.setScrollValue(view.verticalScrollBar()->maximum());const auto offscreen=colors();QVERIFY(!offscreen.first&&!offscreen.second);QVERIFY(view.pendingEdits().isEmpty());
  }
  void imageRefreshAndResizeDoNotPolluteUndo() {
    const auto path=fixture("![alt](resize.png)\n\nTail\n");const QString imagePath=files_.filePath("resize.png");QImage image(1200,600,QImage::Format_RGB32);image.fill(Qt::red);QVERIFY(image.save(imagePath));
    DocumentView view;view.resize(820,800);view.show();view.setPlan(bridge::planFor("![alt](resize.png)\n\nTail\n").value("plan").toObject(),path);view.setFocus();
    QVERIFY(view.revealText("Tail"));QTest::keyClick(&view,Qt::Key_Right);QTest::keyClicks(&view,"abc");view.grab();view.resize(640,800);QCoreApplication::processEvents();QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QVERIFY(view.pendingEdits().isEmpty());
    QVERIFY(view.revealText("Tail"));QTest::keyClick(&view,Qt::Key_Right);QTest::keyClicks(&view,"abc");image=QImage(1200,1200,QImage::Format_RGB32);image.fill(Qt::blue);QVERIFY(image.save(imagePath));QFocusEvent focus(QEvent::FocusIn);QApplication::sendEvent(&view,&focus);view.grab();QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QVERIFY(view.pendingEdits().isEmpty());
  }
  void structuralEnterAndMultiDigitIndent() {
    DocumentView view;view.resize(1000,800);view.show();auto open=[&](const QString& text){view.setPlan(bridge::planFor(text).value("plan").toObject(),QString());view.setFocus();};
    auto edited=[&](){QStringList parts;for(const auto& edit:view.pendingEdits())parts<<edit.second;return parts.join("\n");};
    open("## abc\n");QVERIFY(view.revealText("a"));QTest::keyClick(&view,Qt::Key_Right);QTest::keyClick(&view,Qt::Key_Return);QCOMPARE(edited(),QString("## a\n\n## bc"));
    open("> quote\n");QVERIFY(view.revealText("quote"));QTest::keyClick(&view,Qt::Key_Right);QTest::keyClick(&view,Qt::Key_Return);QTest::keyClick(&view,Qt::Key_Return);QTest::keyClicks(&view,"outside");QCOMPARE(edited(),QString("> quote\n\noutside"));
    open("**bold**\n");QVERIFY(view.revealText("bold"));QTest::keyClick(&view,Qt::Key_Right);QTest::keyClick(&view,Qt::Key_Return);QTest::keyClicks(&view,"X");QCOMPARE(edited(),QString("**bold**\n\n**X**"));
    open("10. parent\n11. child\n");QVERIFY(view.revealText("child"));QTest::keyClick(&view,Qt::Key_Right);QTest::keyClick(&view,Qt::Key_Tab);QCOMPARE(edited(),QString("10. parent\n    11. child"));
  }
  void authorizedImageBytesRevalidateOnRead() {
    const auto path=fixture("# Image\n");const QString imagePath=files_.filePath("checked.png");QImage image(24,24,QImage::Format_RGB32);image.fill(Qt::red);QVERIFY(image.save(imagePath));
    const QJsonObject valid=bridge::readImage(path,"checked.png");QVERIFY(valid.value("ok").toBool());QVERIFY(!valid.contains("path"));QVERIFY(valid.value("dataUrl").toString().startsWith("data:image/png;base64,"));
    QFile file(imagePath);QVERIFY(file.open(QIODevice::WriteOnly|QIODevice::Truncate));const QByteArray tooLarge(10*1024*1024+1,'x');QCOMPARE(file.write(tooLarge),qint64(tooLarge.size()));file.close();
    QVERIFY(!bridge::readImage(path,"checked.png").value("ok").toBool());QVERIFY(QFile::remove(imagePath));QVERIFY(!bridge::readImage(path,"checked.png").value("ok").toBool());
  }
  void emptyStateDisablesDocumentActionsAndRetriesFailedOpen() {
    MainWindow w;w.show();QTest::qWait(10);auto* toolbar=w.findChild<Toolbar*>();auto* modes=toolbar->findChild<SegmentedControl*>();QVERIFY(modes);QVERIFY(!modes->isEnabled());
    int tools=0;for(auto* button:toolbar->findChildren<QToolButton*>()){if(button->isCheckable()){++tools;QVERIFY(!button->isEnabled());}}QCOMPARE(tools,2);
    mode(w,1);QVERIFY(!source(w)->isVisible());w.openSearchPanel(false);QVERIFY(!w.findChild<SearchPanel*>()->isVisible());
    const QImage empty=doc(w)->viewport()->grab().toImage();w.openPath(files_.filePath("does-not-exist.md"));QCoreApplication::processEvents();QVERIFY(!modes->isEnabled());QVERIFY(doc(w)->viewport()->grab().toImage()!=empty);
    const QString error=bridge::openDocument(files_.filePath("does-not-exist.md")).value("message").toString();QVERIFY(!error.isEmpty());bool shown=false;for(auto* label:toolbar->findChildren<QLabel*>())if(label->text()==error)shown=true;QVERIFY(shown);
    const auto path=fixture("# Retried\n\nBody\n");w.openPath(path);QVERIFY(modes->isEnabled());QVERIFY(doc(w)->document()->toPlainText().contains("Retried"));
    for(auto* button:toolbar->findChildren<QToolButton*>())if(button->isCheckable())QVERIFY(button->isEnabled());
  }
  void successfulSaveFeedbackClearsOnEdit() {
    const auto path=fixture("Body\n");MainWindow w;show(w,path);QVERIFY(documentAppend(w,"Body","saved"));save(w);
    auto saved=[&]{for(auto* label:w.findChild<Toolbar*>()->findChildren<QLabel*>())if(label->text()==QString::fromUtf8("已保存"))return true;return false;};
    QVERIFY(saved());QVERIFY(documentAppend(w,"Bodysaved","edit"));QVERIFY(!saved());
  }
  void selectionMimePreservesRichTextWithoutClipboard() {
    const auto path=fixture("Body **word** tail\n");MainWindow w;show(w,path);QVERIFY(doc(w)->revealText("word"));
    const auto mime=doc(w)->selectionMime();QCOMPARE(mime.value("text").toString(),QString("word"));QTextDocument pasted;pasted.setHtml(mime.value("html").toString());
    const auto word=pasted.find("word");QVERIFY(!word.isNull());QVERIFY(word.charFormat().fontWeight()>=QFont::DemiBold);QVERIFY(!doc(w)->hasPendingEdits());QCOMPARE(read(path),QByteArray("Body **word** tail\n"));
  }
  void packagedIconResourceExists() { QIcon icon(":/vellora/icon.ico"); QVERIFY(!icon.isNull()); QVERIFY(!icon.pixmap(64,64).isNull()); }
  void blockShortcutSavesAndUndoes_data() {
    QTest::addColumn<int>("key"); QTest::addColumn<int>("modifiers"); QTest::addColumn<QByteArray>("expected");
    for(int level=1;level<=6;++level) QTest::newRow(qPrintable(QString("heading-%1").arg(level)))<<int(Qt::Key_0+level)<<int(Qt::ControlModifier|Qt::AltModifier)<<(QByteArray(level,'#')+" Body word tail\n");
    QTest::newRow("ordered")<<int(Qt::Key_7)<<int(Qt::ControlModifier|Qt::ShiftModifier)<<QByteArray("1. Body word tail\n");
    QTest::newRow("bullet")<<int(Qt::Key_8)<<int(Qt::ControlModifier|Qt::ShiftModifier)<<QByteArray("- Body word tail\n");
    QTest::newRow("quote-not-bold")<<int(Qt::Key_B)<<int(Qt::ControlModifier|Qt::ShiftModifier)<<QByteArray("> Body word tail\n");
  }
  void blockShortcutSavesAndUndoes() {
    QFETCH(int,key); QFETCH(int,modifiers); QFETCH(QByteArray,expected);
    const QByteArray original("Body word tail\n"); const auto path=fixture(original); MainWindow w;show(w,path);
    QVERIFY(doc(w)->revealText("word"));doc(w)->setFocus();QTest::keyClick(doc(w),Qt::Key(key),Qt::KeyboardModifiers(modifiers));save(w);QCOMPARE(read(path),expected);
    QTest::keyClick(doc(w),Qt::Key_Z,Qt::ControlModifier);save(w);QCOMPARE(read(path),original);
  }
  void formatOnlyEditsSaveAndUndo_data() {
    QTest::addColumn<int>("key");QTest::addColumn<int>("modifiers");QTest::addColumn<QByteArray>("expected");
    QTest::newRow("inline-code")<<int(Qt::Key_E)<<int(Qt::ControlModifier)<<QByteArray("Body `word` tail\n");
      QTest::newRow("bold")<<int(Qt::Key_B)<<int(Qt::ControlModifier)<<QByteArray("Body **word** tail\n");
    QTest::newRow("italic")<<int(Qt::Key_I)<<int(Qt::ControlModifier)<<QByteArray("Body *word* tail\n");
    QTest::newRow("original-strike")<<int(Qt::Key_S)<<int(Qt::ControlModifier|Qt::ShiftModifier)<<QByteArray("Body ~~word~~ tail\n");
      QTest::newRow("strike")<<int(Qt::Key_X)<<int(Qt::ControlModifier|Qt::ShiftModifier)<<QByteArray("Body ~~word~~ tail\n");
  }
  void formatOnlyEditsSaveAndUndo() {
    QFETCH(int,key);QFETCH(int,modifiers);QFETCH(QByteArray,expected);const QByteArray original("Body word tail\n");const auto path=fixture(original);MainWindow w;show(w,path);QVERIFY(doc(w)->revealText("word"));doc(w)->setFocus();
    QTest::keyClick(doc(w),Qt::Key(key),Qt::KeyboardModifiers(modifiers));save(w);QCOMPARE(read(path),expected);
    QTest::keyClick(doc(w),Qt::Key_Z,Qt::ControlModifier);const int before=dialogs_;QVERIFY(!w.close());QVERIFY(dialogs_>before);save(w);QCOMPARE(read(path),original);
  }
  void imageDeleteTypeUndoAndInlineAppend() {
    QImage image(24,24,QImage::Format_RGB32);image.fill(Qt::red);QVERIFY(image.save(files_.filePath("image.png")));const auto path=fixture("![alt](image.png)\n\nTail\n");
    DocumentView view;view.resize(820,700);view.show();auto open=[&]{view.setPlan(bridge::planFor("![alt](image.png)\n\nTail\n").value("plan").toObject(),path);view.setFocus();};
    auto redPixels=[&]{const QImage shot=view.viewport()->grab().toImage().convertToFormat(QImage::Format_RGB32);int count=0;for(int y=0;y<shot.height();++y){const QRgb* row=reinterpret_cast<const QRgb*>(shot.constScanLine(y));for(int x=0;x<shot.width();++x)if(qRed(row[x])>200&&qGreen(row[x])<50&&qBlue(row[x])<50)++count;}return count;};
    open();QVERIFY(redPixels()>0);QTest::keyClick(&view,Qt::Key_Home,Qt::ControlModifier);QTest::keyClick(&view,Qt::Key_Delete);QTest::qWait(1);QCOMPARE(redPixels(),0);
    QTest::keyClicks(&view,"typed");QCOMPARE(view.pendingEdits().size(),1);QCOMPARE(view.pendingEdits().first().second,QString("typed"));
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QTest::qWait(1);QVERIFY(view.pendingEdits().isEmpty());QVERIFY(redPixels()>0);
    open();QTest::keyClick(&view,Qt::Key_Home,Qt::ControlModifier);QTest::keyClick(&view,Qt::Key_Right);QTest::keyClicks(&view,"after");QCOMPARE(view.pendingEdits().size(),1);QCOMPARE(view.pendingEdits().first().second,QString("![alt](image.png)after"));
    QCOMPARE(read(path),QByteArray("![alt](image.png)\n\nTail\n"));
  }
  void firstSourceModeUsesReadingAnchor_data() {QTest::addColumn<bool>("imageBlock");QTest::newRow("high-image")<<true;QTest::newRow("long-raw")<<false;}
  void firstSourceModeUsesReadingAnchor() {
    QFETCH(bool,imageBlock);QString prefix="# Top\n\n";
    if(imageBlock){QImage image(800,2400,QImage::Format_RGB32);image.fill(Qt::red);QVERIFY(image.save(files_.filePath("high.png")));prefix+="![high](high.png)\n\n";}
    else prefix+="<div>\n"+QString("<p>raw content</p>\n").repeated(80)+"</div>\n\n";
    const QString text=prefix+"ANCHOR_BODY\n\n"+QString("Following paragraph.\n\n").repeated(200);const auto path=fixture(text.toUtf8());MainWindow w;show(w,path);QVERIFY(doc(w)->revealText("ANCHOR_BODY"));
    const QJsonObject anchor=doc(w)->readingAnchor();QVERIFY(!anchor.value("source").toString().isEmpty());mode(w,1);
    const int expected=text.indexOf(anchor.value("source").toString());QVERIFY(expected>=0);
    const int actual=source(w)->textCursor().position();QVERIFY2(actual>=expected&&actual<=expected+anchor.value("source").toString().size(),qPrintable(QString("source offset %1 outside anchor range %2..%3").arg(actual).arg(expected).arg(expected+anchor.value("source").toString().size())));
    QCOMPARE(read(path),text.toUtf8());
  }
  void sourceReparseRestoresDocumentSelection() {
    const QString prefix="# Top\n\n"+QString("Middle paragraph.\n\n").repeated(80);const auto path=fixture((prefix+"SELECTED_WORD").toUtf8());MainWindow w;show(w,path);QVERIFY(doc(w)->revealText("SELECTED_WORD"));
    sourceAppend(w," NEW");mode(w,0);doc(w)->setFocus();QTest::keyClicks(doc(w),"REPLACED");save(w);QCOMPARE(read(path),(prefix+"REPLACED NEW").toUtf8());
  }
  void sourceRevealOffsetHandlesWrappedLines() {
    SourceView view;view.resize(820,600);view.show();const QString original=QString("line\n").repeated(120)+QString("wrapped ").repeated(500)+"\nTail\n";view.setMarkdown(original);QCoreApplication::processEvents();
    const int target=original.indexOf("wrapped")+2000;view.revealOffset(target);QCOMPARE(view.textCursor().position(),target);QVERIFY(!view.textCursor().hasSelection());
    QVERIFY(view.cursorRect().top()>=0);QVERIFY(view.cursorRect().bottom()<=view.viewport()->height());
    QCOMPARE(view.viewport()->mapTo(&view, view.cursorRect().topLeft()).y(), 24);
    view.revealOffset(-123);QCOMPARE(view.textCursor().position(),0);
    QCOMPARE(view.viewport()->mapTo(&view, view.cursorRect().topLeft()).y(), 24);
    QTest::keyClick(&view, Qt::Key_Home, Qt::ControlModifier);
    QCOMPARE(view.viewport()->geometry().top(), 32);
    view.revealOffset(original.size()+100);QCOMPARE(view.textCursor().position(),original.size());
    QVERIFY(view.cursorRect().bottom()<=view.viewport()->height());QCOMPARE(view.markdown(),original);QVERIFY(!view.document()->isUndoAvailable());
    view.setMarkdown(QString());view.revealOffset(50);QCOMPARE(view.textCursor().position(),0);
  }
  void sourceHistoryRetainsPixelInsetAfterDocumentEdit() {
    const QByteArray original("# Anchor\n\nBody\n\nTAIL\n");
    const auto path = fixture(original); MainWindow w; show(w, path); mode(w, 1);
    auto* editor = source(w); editor->revealOffset(0);
    QTextCursor selection(editor->document()); selection.setPosition(2);
    selection.setPosition(8, QTextCursor::KeepAnchor); editor->setTextCursor(selection);
    const int inset = editor->topInset(); QVERIFY(inset < 32);
    const int scroll = editor->verticalScrollBar()->value();
    const int y = editor->viewport()->mapTo(editor, editor->cursorRect().topLeft()).y();
    mode(w, 0); QVERIFY(documentAppend(w, "TAIL", "X")); mode(w, 1);
    QCOMPARE(editor->topInset(), inset); QCOMPARE(editor->verticalScrollBar()->value(), scroll);
    QCOMPARE(editor->textCursor().anchor(), 2); QCOMPARE(editor->textCursor().position(), 8);
    QCOMPARE(editor->viewport()->mapTo(editor, editor->cursorRect().topLeft()).y(), y);
    QCOMPARE(editor->markdown(), QString::fromUtf8(original).replace("TAIL", "TAILX"));
    QCOMPARE(read(path), original); save(w);
    QCOMPARE(read(path), QByteArray(original).replace("TAIL", "TAILX"));
    w.openPath(fixture("# Other\n\nDifferent file\n")); QCoreApplication::processEvents();
    QCOMPARE(editor->topInset(), 32);
  }
  void referenceReparseRefreshDoesNotEdit() {
    DocumentView view;view.resize(1000,800);view.show();
    const QString before="[link][ref]\n\n[ref]: https://one.example/\n";
    const QString after="[link][ref]\n\n[ref]: https://two.example/\n";
    view.setPlan(bridge::planFor(before).value("plan").toObject(),QString());
    QCOMPARE(view.document()->find("link").charFormat().anchorHref(),QString("https://one.example/"));
    view.setPlan(bridge::planFor(after).value("plan").toObject(),QString());
    view.setPreviewContext(after);
    QCOMPARE(view.document()->find("link").charFormat().anchorHref(),QString("https://two.example/"));
    QVERIFY(view.pendingEdits().isEmpty());
    QVERIFY(view.document()->resource(QTextDocument::ImageResource,QUrl("https://example.invalid/private.png")).value<QImage>().isNull());
  }
  void fidelityModeRoundtrip_data() {
    QTest::addColumn<QByteArray>("bytes"); QTest::addColumn<QString>("needle"); QTest::addColumn<QByteArray>("expected");
    QTest::newRow("reference") << QByteArray("before [label][r] tail\n\n[r]: https://example.com/\n") << QString("tail") << QByteArray("before [label][r] tailMARK\n\n[r]: https://example.com/\n");
    QTest::newRow("image-alt") << QByteArray("before ![**important** alt](missing.png) tail\n") << QString("tail") << QByteArray("before ![**important** alt](missing.png) tailMARK\n");
    QTest::newRow("hidden-comment") << QByteArray("<!-- retained -->\n\nbody\n") << QString("body") << QByteArray("<!-- retained -->\n\nbodyMARK\n");
    QTest::newRow("empty-list") << QByteArray("1. alpha\n2.\n3. gamma\n") << QString("alpha") << QByteArray("1. alphaMARK\n2. \n3. gamma\n");
  }
  void fidelityModeRoundtrip() {
    QFETCH(QByteArray,bytes); QFETCH(QString,needle); QFETCH(QByteArray,expected);
    const auto path=fixture(bytes); MainWindow w;show(w,path);QVERIFY(documentAppend(w,needle,"MARK"));
    mode(w,1);QCOMPARE(source(w)->markdown().toUtf8(),expected);mode(w,0);save(w);QCOMPARE(read(path),expected);
    mode(w,1);mode(w,0);save(w);QCOMPARE(read(path),expected);
  }
  void sourceReferenceDefinitionRefreshesNativeLink() {
    const auto path=fixture("before [label][r] tail\n\n[r]: https://one.example/\n");MainWindow w;show(w,path);
    QCOMPARE(doc(w)->document()->find("label").charFormat().anchorHref(),QString("https://one.example/"));
    mode(w,1);auto cursor=source(w)->document()->find("https://one.example/");QVERIFY(!cursor.isNull());source(w)->setTextCursor(cursor);source(w)->setFocus();QTest::keyClicks(source(w),"https://two.example/");
    mode(w,0);QCOMPARE(doc(w)->document()->find("label").charFormat().anchorHref(),QString("https://two.example/"));save(w);
    QCOMPARE(read(path),QByteArray("before [label][r] tail\n\n[r]: https://two.example/\n"));
  }
  void syntaxHighlightAliasesAndBounds() {
    for(const QString& alias:QStringList{"ts","typescript","js","javascript","mjs","cjs","json","jsonc","bash","sh","zsh","css","markdown","md","mkd","mkdown","xml","html","xhtml","rss","atom","xjb","xsd","xsl","plist","wsf","svg","jsx","tsx","language-bash","language-CSS","language-html"}) QVERIFY2(codehighlight::supports(alias),qPrintable(alias));
    const QList<QPair<QString,QString>> samples={{"typescript","const x: string = 'text'; // note"},{"javascript","function f() { return true; } // note"},{"json","{\"title\": true, \"count\": 1}"},{"bash","# comment\nif test \"$HOME\"; then echo $USER; fi"},{"css","/* comment */ .a { color: #fff; width: 12px; }"},{"markdown","# Heading\n> quote\n- **bold** and [link](https://example.com)"},{"xml","<!-- comment --> <root id=\"x\">&amp;</root>"}};
    for(const auto& sample:samples){QVERIFY(!codehighlight::ranges(sample.second,sample.first).isEmpty());for(int length=0;length<=sample.second.size();++length)for(const auto& span:codehighlight::ranges(sample.second.left(length),sample.first)){QVERIFY(span.start>=0);QVERIFY(span.length>0);QVERIFY(span.start+span.length<=length);}}
    const QString unicode=QString::fromUtf8(u8"const emoji = '😀';")+QChar::LineSeparator+"// comment"+QChar::LineSeparator+"return 42;";bool foundReturn=false;
    for(const auto& span:codehighlight::ranges(unicode,"js")){QVERIFY(span.start+span.length<=unicode.size());foundReturn|=unicode.mid(span.start,span.length)=="return";}
    QVERIFY(foundReturn);QVERIFY(codehighlight::ranges(unicode,"unknown-language").isEmpty());QVERIFY(codehighlight::ranges(unicode,QString()).isEmpty());
  }
  void syntaxHighlightPreservesTextAndUndo() {
    class Highlight : public QSyntaxHighlighter {public:using QSyntaxHighlighter::QSyntaxHighlighter;void highlightBlock(const QString& text) override {for(const auto& span:codehighlight::ranges(text,"ts"))setFormat(span.start,span.length,span.format);}};
    const QString original="const x: string = 'text';\n// note\n";QTextDocument document;document.setPlainText(original);document.clearUndoRedoStacks();Highlight highlighter(&document);highlighter.rehighlight();
    QCOMPARE(document.toPlainText(),original);QVERIFY(!document.isUndoAvailable());QTextCursor cursor(&document);cursor.movePosition(QTextCursor::End);cursor.insertText("const y = 42;");highlighter.rehighlight();document.undo();QCOMPARE(document.toPlainText(),original);
  }
  void latestOpenQueuedDuringModal() {
    cancelDialogs_.stop();const auto a=fixture("# A\n");const auto b=fixture("# B\n");const auto c=fixture("# C\n");MainWindow w;show(w,a);sourceAppend(w,"UNSAVED");
    int phase=0;QTimer answer;connect(&answer,&QTimer::timeout,&w,[&]{
      for(auto* widget:QApplication::allWidgets())if(auto* dialog=qobject_cast<ModalDialog*>(widget))if(dialog->isVisible()){
        if(phase==0){phase=1;w.openPath(b);w.openPath(c,true);QTest::keyClick(dialog,Qt::Key_Escape);return;}
        if(phase==1){for(auto* button:dialog->findChildren<QPushButton*>())if(button->property("primary").toBool()){phase=2;QTest::mouseClick(button,Qt::LeftButton);return;}}
      }
    });answer.start(5);w.openPath(b);QTRY_COMPARE_WITH_TIMEOUT(phase,2,2000);QTRY_COMPARE_WITH_TIMEOUT(source(w)->markdown(),QString("# C\n"),2000);
    QVERIFY(source(w)->isVisible());QCOMPARE(read(a),QByteArray("# A\n"));QCOMPARE(read(b),QByteArray("# B\n"));QCOMPARE(read(c),QByteArray("# C\n"));
  }
  void imeSessionDoesNotCarryDeferredClose() {
    const auto a=fixture("# A\n");const auto b=fixture("# B\n");MainWindow w;show(w,a);doc(w)->setFocus();
    QInputMethodEvent preedit("pending",{});QApplication::sendEvent(doc(w),&preedit);QVERIFY(doc(w)->isComposing());
    w.openPath(b);QVERIFY(!w.close());QInputMethodEvent cancel;QApplication::sendEvent(doc(w),&cancel);
    QTRY_VERIFY_WITH_TIMEOUT(doc(w)->document()->toPlainText().contains("B"),2000);
    QCOMPARE(w.windowTitle(),QString("Vellora"));QVERIFY(w.isVisible());
    QInputMethodEvent second("pending",{});QApplication::sendEvent(doc(w),&second);QVERIFY(!w.close());
    QInputMethodEvent finish;QApplication::sendEvent(doc(w),&finish);QTRY_VERIFY_WITH_TIMEOUT(!w.isVisible(),2000);
    QCOMPARE(read(a),QByteArray("# A\n"));QCOMPARE(read(b),QByteArray("# B\n"));
  }
  void outlineTargetsSourceTokens() {
    const QString markdown = QString::fromUtf8(u8"Repeat\r\n\r\n# **Repeat**\r\n\r\n😀 中文在前\r\n\r\n## 中文标题\r\n\r\n<div>\r\n<h3>Raw heading</h3>\r\n</div>\r\n\r\n> ### Nested\r\n");
    const auto path=fixture(markdown.toUtf8()); MainWindow w; show(w,path); mode(w,1);
    QString normalized=markdown; normalized.replace("\r\n","\n");
    const QStringList markers={"# **Repeat**",QString::fromUtf8(u8"## 中文标题"),"<h3>","### Nested"};
    auto* outline=w.findChild<OutlinePanel*>(); QVERIFY(outline);
    for(int i=0;i<markers.size();++i) {
      emit w.findChild<Toolbar*>()->outlineRequested();
      emit outline->headingSelected(i);
      QCOMPARE(source(w)->textCursor().position(),normalized.indexOf(markers.at(i)));
    }
    QCOMPARE(read(path),markdown.toUtf8());
  }
  void listEditingKeys() {
    DocumentView view; view.resize(1000,800); view.show();
    auto open=[&](const QString& text){view.setPlan(bridge::planFor(text).value("plan").toObject(),QString());view.setFocus();};
    auto edited=[&](){QStringList parts;for(const auto& edit:view.pendingEdits())parts<<edit.second;return parts.join("\n");};
    open("- first\n- second\n"); QVERIFY(view.revealText("second")); QTest::keyClick(&view,Qt::Key_Right); QTest::keyClick(&view,Qt::Key_Tab);
    QCOMPARE(edited(),QString("- first\n  - second")); QTest::keyClick(&view,Qt::Key_Backtab); QVERIFY(view.pendingEdits().isEmpty());
    QTest::keyClick(&view,Qt::Key_Return); QTest::keyClick(&view,Qt::Key_Return); QTest::keyClicks(&view,"outside");
    QCOMPARE(edited(),QString("- first\n- second\n\noutside"));
    open("- first\n- second\n"); QVERIFY(view.revealText("second")); QTest::keyClick(&view,Qt::Key_Left); QTest::keyClick(&view,Qt::Key_Backspace);
    QCOMPARE(edited(),QString("- first\n\nsecond"));
  }
  void tableEditingKeys() {
    DocumentView view;view.resize(1000,800);view.show();
    view.setPlan(bridge::planFor("| a | b |\n| --- | --- |\n| c | d |\n").value("plan").toObject(),QString());view.setFocus();
    auto edited=[&](){QStringList parts;for(const auto& edit:view.pendingEdits())parts<<edit.second;return parts.join("\n");};
    QVERIFY(view.revealText("c"));QTest::keyClick(&view,Qt::Key_Right);QTest::keyClick(&view,Qt::Key_Tab);QTest::keyClicks(&view,"X");
    QVERIFY2(edited().contains("| c | Xd |"),qPrintable(edited()));QTest::keyClick(&view,Qt::Key_Return);QTest::keyClicks(&view,"Y");
    QVERIFY2(edited().contains("X<br>Yd"),qPrintable(edited()));QTest::keyClick(&view,Qt::Key_Tab);QTest::keyClicks(&view,"row");
    QVERIFY2(edited().contains("| row |  |"),qPrintable(edited()));
  }
  void imeReplacementRangeAndUndo() {
    DocumentView view;view.resize(1000,800);view.show();view.setPlan(bridge::planFor("bodyabc\n").value("plan").toObject(),QString());view.setFocus();
    QVERIFY(view.revealText("bodyabc"));QTest::keyClick(&view,Qt::Key_Right);QInputMethodEvent event;event.setCommitString("Z",-3,3);QApplication::sendEvent(&view,&event);
    const auto edits=view.pendingEdits();QCOMPARE(edits.size(),1);QCOMPARE(edits.first().second,QString("bodyZ"));
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QVERIFY(view.pendingEdits().isEmpty());
  }
  void replaceAcrossFormattingAndUndo() {
    DocumentView view;view.resize(1000,800);view.show();view.setPlan(bridge::planFor("**a**b and ab\n").value("plan").toObject(),QString());view.setFocus();
    view.setSearchQuery("ab",true);QCOMPARE(view.replaceAll("z"),2);const auto edits=view.pendingEdits();QCOMPARE(edits.size(),1);QCOMPARE(edits.first().second,QString("z and z"));
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QVERIFY(view.pendingEdits().isEmpty());view.setSearchQuery("",false);QVERIFY(view.pendingEdits().isEmpty());
  }
  void rawSearchRevealKeepsQueryFocusAndContent() {
    const QByteArray original("<div>needle</div>\n\nTail\n");
    const auto path = fixture(original); MainWindow w; show(w, path);
    auto* view = doc(w);
    const auto content = view->document()->toPlainText();
    const auto raw = view->document()->find("<div>");
    QVERIFY(!raw.isNull()); QVERIFY(!raw.block().isVisible());
    QSignalSpy edits(view, &DocumentView::contentEdited);
    w.openSearchPanel(false);
    auto* query = qobject_cast<QLineEdit*>(QApplication::focusWidget());
    QVERIFY(query); QVERIFY(w.findChild<SearchPanel*>()->isAncestorOf(query));
    QTest::keyClicks(QApplication::focusWidget(), "need");
    QVERIFY(raw.block().isVisible());
    QCOMPARE(QApplication::focusWidget(), static_cast<QWidget*>(query));
    // Use the actual focus target so accidental editor focus cannot be masked.
    QTest::keyClicks(QApplication::focusWidget(), "le");
    QCOMPARE(query->text(), QString("needle"));
    QCOMPARE(view->searchMatchCount(), 1);
    QCoreApplication::processEvents();
    QCOMPARE(QApplication::focusWidget(), static_cast<QWidget*>(query));
    QCOMPARE(view->document()->toPlainText(), content);
    QCOMPARE(edits.count(), 0); QVERIFY(!view->hasPendingEdits());
    QVERIFY(!view->document()->isUndoAvailable());
    save(w); QCOMPARE(read(path), original);

    // The requested removal of inline toggles does not remove the toolbar's
    // source mode, or let searching mutate the raw fragment.
    query->clear();
    QTest::keyClick(query, Qt::Key_Escape);
    const auto toggles = view->viewport()->findChildren<QPushButton*>(QString(), Qt::FindDirectChildrenOnly);
    QVERIFY(toggles.isEmpty());
    mode(w, 1);
    QVERIFY(source(w)->hasFocus());
    QCOMPARE(source(w)->markdown(), QString::fromUtf8(original));
    mode(w, 0);
    QVERIFY(view->hasFocus());
    QCOMPARE(view->document()->toPlainText(), content);
    QCOMPARE(edits.count(), 0); QVERIFY(!view->hasPendingEdits());
    QVERIFY(!view->document()->isUndoAvailable());
  }
  void floatingOutlineUsesLegacyHeaderGeometry() {
    QWidget host; host.resize(820, 900);
    OutlinePanel panel(&host); panel.setFloating(true); panel.resize(248, 420);
    panel.setHeadings(QJsonArray{QJsonObject{{"level", 1}, {"text", "Heading"}}});
    host.show(); panel.show(); QCoreApplication::processEvents();
    auto* column = qobject_cast<QVBoxLayout*>(panel.layout()); QVERIFY(column);
    QWidget* header = column->itemAt(0)->widget(); QVERIFY(header);
    auto* scroll = panel.findChild<QScrollArea*>(); QVERIFY(scroll);
    auto* close = header->findChild<QToolButton*>(); QVERIFY(close);
    QCOMPARE(header->height(), 32); QCOMPARE(close->size(), QSize(28, 28));
    QCOMPARE(scroll->y() - (header->y() + header->height()), 4);
    QCOMPARE(header->width() - (close->x() + close->width()), 12);
    const auto items = scroll->widget()->findChildren<QPushButton*>();
    QCOMPARE(items.size(), 1);
    QCOMPARE(items.first()->mapTo(&panel, QPoint()).y() - header->y(), 36);
  }
  void outlineLongLabelsKeepIdentityAndActivation() {
    QWidget host; host.resize(820, 600);
    OutlinePanel panel(&host); panel.setFloating(true); panel.resize(248, 400);
    const QString label = QStringLiteral("A&B ") + QString(100, QLatin1Char('W'));
    panel.setHeadings(QJsonArray{QJsonObject{{"level", 5}, {"text", label}}});
    host.show(); panel.show(); QCoreApplication::processEvents();
    auto* scroll = panel.findChild<QScrollArea*>(); QVERIFY(scroll);
    const auto buttons = scroll->widget()->findChildren<QPushButton*>(); QCOMPARE(buttons.size(), 1);
    auto* button = buttons.first(); QCOMPARE(button->text(), label); QCOMPARE(button->toolTip(), label);
    QVERIFY(button->fontMetrics().horizontalAdvance(label) > button->width());
    QVERIFY(button->fontMetrics().elidedText(label, Qt::ElideRight, button->width() - 64).endsWith(QChar(0x2026)));
    QVERIFY(!button->grab().isNull());
    QSignalSpy activated(&panel, &OutlinePanel::headingSelected);
    button->setFocus(); QTest::keyClick(button, Qt::Key_Space);
    QCOMPARE(activated.count(), 1); QCOMPARE(activated.first().first().toInt(), 0);
  }
  void listMarkerPaintingDoesNotChangeDocument() {
    const QByteArray original("- outer\n  - nested\n- next\n\n1. numbered\n2. second\n");
    const auto path = fixture(original); MainWindow w; show(w, path);
    auto* view = doc(w); const QString plain = view->document()->toPlainText();
    QSignalSpy edits(view, &DocumentView::contentEdited);
    view->viewport()->grab(); view->resize(640, 600); view->viewport()->grab();
    view->resize(820, 900); view->viewport()->grab();
    QCOMPARE(view->document()->toPlainText(), plain);
    QCOMPARE(edits.count(), 0); QVERIFY(!view->hasPendingEdits());
    QVERIFY(!view->document()->isUndoAvailable()); save(w); QCOMPARE(read(path), original);
  }
  void headingToTableRetainsWrapperSpacing() {
    const QByteArray original("### Table heading\n\n| Head | Other |\n| --- | --- |\n| one | two |\n");
    const auto path = fixture(original); MainWindow w; show(w, path);
    auto* view = doc(w); view->viewport()->grab();
    QTextTable* table = nullptr;
    for (auto* frame : view->document()->rootFrame()->childFrames())
      if (auto* candidate = qobject_cast<QTextTable*>(frame)) table = candidate;
    QVERIFY(table);
    const auto heading = view->document()->find("Table heading").block();
    QVERIFY(heading.isValid());
    auto* layout = view->document()->documentLayout();
    const qreal gap = layout->frameBoundingRect(table).top() - layout->blockBoundingRect(heading).bottom();
    QVERIFY2(qAbs(gap - 28) <= 2, qPrintable(QString("Heading bottom 12px + wrapped-table margin 16px; measured gap=%1").arg(gap)));
    QVERIFY(!view->hasPendingEdits()); QVERIFY(!view->document()->isUndoAvailable());
    save(w); QCOMPARE(read(path), original);
  }
  void codeAndTableGeometryPreserveDocument() {
    const QByteArray original("```text\nfirst\nsecond\nthird\n```\n\n| Head | Other |\n| --- | --- |\n| one | two |\n| three | four |\n");
    const auto path = fixture(original); MainWindow w; show(w, path);
    auto* view = doc(w); view->viewport()->grab();
    QSignalSpy edits(view, &DocumentView::contentEdited);
    const auto code = view->document()->find("first").block();
    QVERIFY(code.isValid()); QCOMPARE(code.layout()->lineCount(), 3);
    for (int i = 1; i < code.layout()->lineCount(); ++i)
      QVERIFY(qAbs(code.layout()->lineAt(i).y() - code.layout()->lineAt(i - 1).y() - 25.6) < 0.2);
    QTextTable* table = nullptr;
    for (auto* frame : view->document()->rootFrame()->childFrames())
      if (auto* candidate = qobject_cast<QTextTable*>(frame)) table = candidate;
    QVERIFY(table); QCOMPARE(table->rows(), 3);
    auto* layout = view->document()->documentLayout();
    for (int row = 1; row < table->rows(); ++row) {
      const qreal previous = layout->blockBoundingRect(table->cellAt(row - 1, 0).firstCursorPosition().block()).top();
      const qreal current = layout->blockBoundingRect(table->cellAt(row, 0).firstCursorPosition().block()).top();
      QVERIFY2(qAbs(current - previous - 42) <= 1, "Single-line table rows must retain the legacy 42px rhythm");
    }
    QCOMPARE(edits.count(), 0); QVERIFY(!view->hasPendingEdits());
    QVERIFY(!view->document()->isUndoAvailable());
    save(w); QCOMPARE(read(path), original);
  }
  void containerBottomPaddingIsNotCollapsedOrDuplicated() {
    const QByteArray original("```text\ncode\n```\n\n### After code\n\n| H |\n| --- |\n| cell |\n\n### After table\n");
    const auto path = fixture(original); MainWindow w; show(w, path);
    auto* view = doc(w); view->viewport()->grab();
    const auto afterCode = view->document()->find("After code").block();
    QCOMPARE(afterCode.blockFormat().topMargin(), qreal(48)); // 32 outer + 16 inner
    QTextTable* table = nullptr;
    for (auto* frame : view->document()->rootFrame()->childFrames())
      if (auto* candidate = qobject_cast<QTextTable*>(frame)) table = candidate;
    QVERIFY(table);
    const auto spacer = table->lastCursorPosition().block().next();
    QVERIFY(spacer.isValid()); QCOMPARE(spacer.blockFormat().lineHeight(), qreal(16));
    const auto afterTable = view->document()->find("After table").block();
    QCOMPARE(afterTable.blockFormat().topMargin(), qreal(32));
    QVERIFY(!view->hasPendingEdits()); QVERIFY(!view->document()->isUndoAvailable());
    save(w); QCOMPARE(read(path), original);
  }
  void adjacentImageAtomsPreserveMultiplicity_data() {
    QTest::addColumn<bool>("loaded"); QTest::addColumn<bool>("distinct");
    QTest::newRow("missing-identical") << false << false;
    QTest::newRow("loaded-identical") << true << false;
    QTest::newRow("missing-distinct") << false << true;
    QTest::newRow("loaded-distinct") << true << true;
  }
  void adjacentImageAtomsPreserveMultiplicity() {
    QFETCH(bool, loaded); QFETCH(bool, distinct);
    const QString name = loaded ? "adjacent-loaded.png" : "adjacent-missing.png";
    if (loaded) { QImage image(16,16,QImage::Format_RGB32); image.fill(Qt::red); QVERIFY(image.save(files_.filePath(name))); }
    const QString first = QString("![a](%1 \"first\")").arg(name);
    const QString second = distinct ? QString("![b](%1 \"second\")").arg(name) : first;
    const QByteArray original = ("Before " + first + second + " After\n").toUtf8();
    const auto path = fixture(original); MainWindow w; show(w, path); auto* view = doc(w);
    QCOMPARE(view->document()->toPlainText().count(QChar::ObjectReplacementCharacter), 2);
    const auto atom = view->document()->find(QString(QChar::ObjectReplacementCharacter)); QVERIFY(!atom.isNull());
    view->restoreSelectionState({atom.selectionStart(), atom.selectionStart() + 2});
    const auto mime = view->selectionMime(); QCOMPARE(mime.value("text").toString(), QString());
    QCOMPARE(mime.value("html").toString().count("<img"), 2);
    QCOMPARE(mime.value("html").toString().count("data-local-src="), 2);
    if (distinct) { QVERIFY(mime.value("html").toString().contains("alt=\"b\"")); QVERIFY(mime.value("html").toString().contains("title=\"second\"")); }
    view->setSearchQuery(name, true); QCOMPARE(view->searchMatchCount(), 0); view->setSearchQuery("", false);
    QVERIFY(documentAppend(w, "After", "X"));
    const QByteArray expected = ("Before " + first + second + " AfterX\n").toUtf8();
    save(w); QCOMPARE(read(path), expected);
    QTest::keyClick(view, Qt::Key_Z, Qt::ControlModifier); save(w); QCOMPARE(read(path), original);
    w.openPath(path); QCOMPARE(doc(w)->document()->toPlainText().count(QChar::ObjectReplacementCharacter), 2);
    QVERIFY(!doc(w)->hasPendingEdits()); QVERIFY(!doc(w)->document()->isUndoAvailable());
  }
  void missingImageAtomicReplacement() {
    const QString markdown = "Before ![alt](missing-atomic.png \"title\") After\n";
    DocumentView view; view.resize(820, 700); view.show();
    view.setPlan(bridge::planFor(markdown).value("plan").toObject(), fixture(markdown.toUtf8()));
    auto atom = view.document()->find(QString(QChar::ObjectReplacementCharacter));
    if (atom.isNull()) {
      // Regression witness for the former multi-character UI-label model:
      // selecting one internal character must never duplicate the image.
      atom = view.document()->find("missing-atomic.png"); QVERIFY(!atom.isNull());
      atom.setPosition(atom.selectionStart() + 2);
      atom.movePosition(QTextCursor::NextCharacter, QTextCursor::KeepAnchor);
    }
    view.restoreSelectionState({atom.selectionStart(), atom.selectionEnd()}); view.setFocus();
    QTest::keyClicks(&view, "X");
    QCOMPARE(view.pendingEdits().size(), 1);
    QCOMPARE(view.pendingEdits().first().second, QString("Before X After"));
    QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier);
    QVERIFY(view.pendingEdits().isEmpty());
  }
  void missingImageLabelKeepsOriginalMarkdownAndUndo() {
    const QByteArray original("Before ![descriptive alt](missing-ui-review-image.png \"image title\") After\n");
    const auto path = fixture(original); MainWindow w; show(w, path);
    auto* view = doc(w);
    QCOMPARE(view->document()->toPlainText().count(QChar::ObjectReplacementCharacter), 1);
    QVERIFY(!view->document()->toPlainText().contains(QStringLiteral("图片缺失")));
    view->setSearchQuery("missing-ui-review-image", true); QCOMPARE(view->searchMatchCount(), 0);
    view->setSearchQuery("", false);
    const QImage painted = view->viewport()->grab().toImage(); int dangerPixels = 0;
    for (int y = 0; y < painted.height(); ++y) for (int x = 0; x < painted.width(); ++x)
      if (painted.pixelColor(x, y) == theme::danger()) ++dangerPixels;
    QVERIFY(dangerPixels > 10);
    QVERIFY(!view->hasPendingEdits()); QVERIFY(!view->document()->isUndoAvailable());
    save(w); QCOMPARE(read(path), original);
    QVERIFY(documentAppend(w, "After", "X"));
    save(w);
    QCOMPARE(read(path), QByteArray("Before ![descriptive alt](missing-ui-review-image.png \"image title\") AfterX\n"));
    QTest::keyClick(view, Qt::Key_Z, Qt::ControlModifier);
    QVERIFY(view->pendingEdits().isEmpty());
    save(w); QCOMPARE(read(path), original);
  }
  void missingImageAtomicDeletion_data() {
    QTest::addColumn<int>("action");
    QTest::newRow("selected-delete") << 0;
    QTest::newRow("backspace") << 1;
    QTest::newRow("delete") << 2;
    QTest::newRow("word-backspace") << 3;
    QTest::newRow("word-delete") << 4;
    QTest::newRow("ime-replacement") << 5;
  }
  void missingImageAtomicDeletion() {
    QFETCH(int, action);
    const QByteArray original("Before ![alt](missing-atomic.png \"title\") After\n");
    const auto path = fixture(original); MainWindow w; show(w, path); auto* view = doc(w);
    const auto atom = view->document()->find(QString(QChar::ObjectReplacementCharacter)); QVERIFY(!atom.isNull());
    const int start = atom.selectionStart(), end = atom.selectionEnd(); QCOMPARE(end - start, 1);
    const bool backward = action == 1 || action == 3;
    if (action == 0 || action == 5) view->restoreSelectionState({start, end});
    else view->restoreSelectionState({backward ? end : start, backward ? end : start});
    view->setFocus();
    if (action == 5) { QInputMethodEvent commit; commit.setCommitString("X"); QApplication::sendEvent(view, &commit); }
    else QTest::keyClick(view, backward ? Qt::Key_Backspace : Qt::Key_Delete,
                         action == 3 || action == 4 ? Qt::ControlModifier : Qt::NoModifier);
    QCOMPARE(view->document()->toPlainText().count(QChar::ObjectReplacementCharacter), 0);
    save(w); const auto changed = read(path); QVERIFY(!changed.contains("!["));
    QVERIFY(changed.contains("Before")); QVERIFY(changed.contains("After"));
    if (action == 5) QCOMPARE(changed, QByteArray("Before X After\n"));
    QTest::keyClick(view, Qt::Key_Z, Qt::ControlModifier); save(w); QCOMPARE(read(path), original);
    w.openPath(path); QCOMPARE(doc(w)->document()->toPlainText().count(QChar::ObjectReplacementCharacter), 1);
    QVERIFY(!doc(w)->hasPendingEdits());
  }
  void missingImageAdjacentInputAndSemanticCopy() {
    const QString markdown = "Before ![alt](missing-atomic.png \"title\") After\n";
    DocumentView view; view.resize(820, 700); view.show();
    view.setPlan(bridge::planFor(markdown).value("plan").toObject(), fixture(markdown.toUtf8()));
    auto atom = view.document()->find(QString(QChar::ObjectReplacementCharacter)); QVERIFY(!atom.isNull());
    view.restoreSelectionState({atom.selectionStart(), atom.selectionEnd()});
    const auto mime = view.selectionMime();
    QCOMPARE(mime.value("text").toString(), QString());
    const QString html = mime.value("html").toString();
    QVERIFY(html.contains("<img")); QVERIFY(html.contains("data-local-src=\"missing-atomic.png\""));
    QVERIFY(!html.contains(" src="));
    QVERIFY(html.contains("alt=\"alt\"")); QVERIFY(html.contains("title=\"title\""));
    QVERIFY(!html.contains(QStringLiteral("图片缺失")));
    const QTextBlock paragraph = atom.block();
    view.restoreSelectionState({paragraph.position(), paragraph.position() + paragraph.length() - 1});
    QCOMPARE(view.selectionMime().value("text").toString(), QString("Before  After"));
    QVERIFY(!view.hasPendingEdits()); QVERIFY(!view.document()->isUndoAvailable());
    for (bool after : {false, true}) {
      atom = view.document()->find(QString(QChar::ObjectReplacementCharacter));
      const int position = after ? atom.selectionEnd() : atom.selectionStart();
      view.restoreSelectionState({position, position}); view.setFocus(); QTest::keyClicks(&view, "X");
      QCOMPARE(view.pendingEdits().size(), 1);
      QCOMPARE(view.pendingEdits().first().second, after ? QString("Before ![alt](missing-atomic.png \"title\")X After")
                                                      : QString("Before X![alt](missing-atomic.png \"title\") After"));
      QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier); QVERIFY(view.pendingEdits().isEmpty());
    }
  }
  void loadedImageCopyUsesSameLeafContract() {
    QImage pixel(16, 16, QImage::Format_RGB32); pixel.fill(Qt::red);
    QVERIFY(pixel.save(files_.filePath("copy-image.png")));
    const QString markdown = "Before ![loaded](copy-image.png \"title\") After\n";
    DocumentView view; view.resize(820, 700); view.show();
    view.setPlan(bridge::planFor(markdown).value("plan").toObject(), fixture(markdown.toUtf8()));
    const auto atom = view.document()->find(QString(QChar::ObjectReplacementCharacter)); QVERIFY(!atom.isNull());
    view.restoreSelectionState({atom.selectionStart(), atom.selectionEnd()});
    const auto mime = view.selectionMime(); QCOMPARE(mime.value("text").toString(), QString());
    QVERIFY(mime.value("html").toString().contains("data-local-src=\"copy-image.png\""));
    QVERIFY(!mime.value("html").toString().contains(" src="));
    QVERIFY(mime.value("html").toString().contains("alt=\"loaded\""));
    QVERIFY(mime.value("html").toString().contains("title=\"title\""));
    QVERIFY(!view.hasPendingEdits()); QVERIFY(!view.document()->isUndoAvailable());
  }
  void missingImageRefreshKeepsOneAtomAndUndo() {
    const QString markdown = "Before ![alt](appearing-atomic.png) After\n";
    const auto path = fixture(markdown.toUtf8());
    DocumentView view; view.resize(820, 700); view.show();
    view.setPlan(bridge::planFor(markdown).value("plan").toObject(), path);
    view.viewport()->grab(); QSignalSpy edits(&view, &DocumentView::contentEdited);
    QImage red(32, 32, QImage::Format_RGB32); red.fill(Qt::red);
    const auto imagePath = files_.filePath("appearing-atomic.png"); QVERIFY(red.save(imagePath));
    QFocusEvent focus(QEvent::FocusIn); QApplication::sendEvent(&view, &focus);
    auto redPixels = [&] { const QImage shot = view.viewport()->grab().toImage(); int count = 0;
      for (int y = 0; y < shot.height(); ++y) for (int x = 0; x < shot.width(); ++x)
        if (shot.pixelColor(x,y) == QColor(Qt::red)) ++count;
      return count;
    };
    QVERIFY(redPixels() >= 500);
    QVERIFY(QFile::remove(imagePath)); QApplication::sendEvent(&view, &focus);
    QCOMPARE(redPixels(), 0);
    QCOMPARE(view.document()->toPlainText().count(QChar::ObjectReplacementCharacter), 1);
    QCOMPARE(edits.count(), 0); QVERIFY(!view.hasPendingEdits()); QVERIFY(!view.document()->isUndoAvailable());
    QCOMPARE(read(path), markdown.toUtf8());
  }
  void rejectedImageCopyStaysInertAndEscaped() {
    const QString markdown = "![alt](javascript:alert%281%29 \"quoted & title\")\n";
    DocumentView view; view.resize(820, 700); view.show();
    view.setPlan(bridge::planFor(markdown).value("plan").toObject(), fixture(markdown.toUtf8()));
    const auto atom = view.document()->find(QString(QChar::ObjectReplacementCharacter)); QVERIFY(!atom.isNull());
    view.restoreSelectionState({atom.selectionStart(), atom.selectionEnd()});
    const auto mime = view.selectionMime(); const auto html = mime.value("html").toString();
    QCOMPARE(mime.value("text").toString(), QString());
    QVERIFY(html.contains("data-local-src=\"javascript:")); QVERIFY(!html.contains(" src="));
    QVERIFY(html.contains("quoted &amp; title"));
    QVERIFY(!view.hasPendingEdits()); QVERIFY(!view.document()->isUndoAvailable());
  }
  void rawHtmlTableSpanAndCodeNoWrap() {
    DocumentView view;view.resize(1000,800);view.show();
    view.setPlan(bridge::planFor("<table><tr><td colspan=\"2\">one</td></tr><tr><td>A</td><td>B</td></tr></table>\n\n# After\n").value("plan").toObject(),QString());
    bool foundSpan=false; const auto previews=view.findChildren<DocumentView*>(); QVERIFY(!previews.isEmpty());
    for(auto* preview:previews)for(auto* frame:preview->document()->rootFrame()->childFrames())if(auto* table=qobject_cast<QTextTable*>(frame))foundSpan|=table->cellAt(0,0).columnSpan()==2;
    QVERIFY(foundSpan);
    const QString code(200,'x');view.setPlan(bridge::planFor("```txt\n"+code+"\n```\n").value("plan").toObject(),QString());
    const QTextCursor found=view.document()->find(code);QVERIFY(!found.isNull());QVERIFY(found.block().layout()->lineCount()<=2);
  }
  void codeEditingShortcutsPreserveContent() {
    for(bool outdent:{false,true}){
      const QByteArray original=outdent?"```js\n  one\n  two\n```\n":"```js\none\ntwo\n```\n";const QByteArray expected=outdent?"```js\none\ntwo\n```\n":"```js\n  one\n  two\n```\n";const auto path=fixture(original);MainWindow w;show(w,path);auto* view=doc(w);
      const auto first=view->document()->find(outdent?"  one":"one"),last=view->document()->find(outdent?"  two":"two");QVERIFY(!first.isNull());QVERIFY(!last.isNull());view->restoreSelectionState({first.selectionStart(),last.selectionEnd()});view->setFocus();QTest::keyClick(view,Qt::Key_Tab,outdent?Qt::ShiftModifier:Qt::NoModifier);save(w);QCOMPARE(read(path),expected);QTest::keyClick(view,Qt::Key_Z,Qt::ControlModifier);save(w);QCOMPARE(read(path),original);
    }
    const QByteArray original("Body word tail\n");const auto path=fixture(original);MainWindow w;show(w,path);QVERIFY(doc(w)->revealText("word"));doc(w)->setFocus();QTest::keyClick(doc(w),Qt::Key_C,Qt::ControlModifier|Qt::AltModifier);save(w);QCOMPARE(read(path),QByteArray("```\nBody word tail\n```\n"));QTest::keyClick(doc(w),Qt::Key_Z,Qt::ControlModifier);save(w);QCOMPARE(read(path),original);QTest::keyClick(doc(w),Qt::Key_Z,Qt::ControlModifier|Qt::ShiftModifier);save(w);QCOMPARE(read(path),QByteArray("```\nBody word tail\n```\n"));
  }
  void codeBoundariesAndHardBreak_data(){QTest::addColumn<int>("operation");for(int i=0;i<6;++i)QTest::newRow(qPrintable(QString::number(i)))<<i;}
  void codeBoundariesAndHardBreak(){
    QFETCH(int,operation);const QByteArray original=operation==3?"Body word\n":operation==5?"```\n\n```\n":"```\ncode\n```\n";const auto path=fixture(original);MainWindow w;show(w,path);auto* view=doc(w);if(operation!=5)QVERIFY(view->revealText(operation==3?"word":"code"));view->setFocus();if(operation==5)QTest::keyClick(view,Qt::Key_Home,Qt::ControlModifier);else QTest::keyClick(view,operation<2?Qt::Key_Left:Qt::Key_Right);
    QByteArray expected;
    if(operation==0){QTest::keyClick(view,Qt::Key_Backspace);expected="code\n";}
    if(operation==1){QTest::keyClick(view,Qt::Key_Up);QTest::keyClicks(view,"before");expected="before\n\n```\ncode\n```\n";}
    if(operation==2){QTest::keyClick(view,Qt::Key_Down);QTest::keyClicks(view,"after");expected="```\ncode\n```\n\nafter\n";}
    if(operation==3){QTest::keyClick(view,Qt::Key_Return,Qt::ControlModifier);QTest::keyClicks(view,"tail");expected="Body word  \ntail\n";}
    if(operation==4){QTest::keyClick(view,Qt::Key_Return,Qt::ControlModifier);QTest::keyClicks(view,"after");expected="```\ncode\n```\n\nafter\n";}
    if(operation==5){QTest::keyClick(view,Qt::Key_Backspace);QTest::keyClicks(view,"body");expected="body\n";}
    save(w);QCOMPARE(read(path),expected);for(int i=0;i<6&&view->hasPendingEdits();++i)QTest::keyClick(view,Qt::Key_Z,Qt::ControlModifier);save(w);QCOMPARE(read(path),original);
  }
  void emptyActionMatchesLegacyWidthAndHitTarget_data() {
    QTest::addColumn<bool>("retry");
    QTest::newRow("open") << false;
    QTest::newRow("retry") << true;
  }
  void emptyActionMatchesLegacyWidthAndHitTarget() {
    QFETCH(bool, retry);
    DocumentView view; view.resize(820, 848); view.show();
    if (retry) view.setErrorState("Unable to open the document");
    else view.setEmptyState();
    view.clearFocus();
    const QPixmap capture = view.viewport()->grab();
    const QImage pixels = capture.toImage();
    const qreal dpr = capture.devicePixelRatio();
    int longest = 0, left = 0, row = 0;
    // The rounded button has the longest uninterrupted text-colour fill.
    // Measure that fill, not a whole-image snapshot or font-dependent constant.
    for (int y = 0; y < pixels.height(); ++y) {
      int run = 0;
      for (int x = 0; x < pixels.width(); ++x) {
        run = pixels.pixelColor(x, y) == theme::text() ? run + 1 : 0;
        if (run > longest) { longest = run; left = x - run + 1; row = y; }
      }
    }
    const QString label = retry ? QStringLiteral("重新选择") : QStringLiteral("打开");
    const qreal expected = QFontMetricsF(theme::uiFont(13)).horizontalAdvance(label) + 24;
    QVERIFY2(qAbs(longest / dpr - expected) <= 2, "Painted button width must equal 13px label plus 12px padding per side");
    const qreal expectedLeft = (view.viewport()->width() - expected) / 2;
    QVERIFY(qAbs(left / dpr - expectedLeft) <= 2);
    QSignalSpy requested(&view, &DocumentView::openRequested);
    const int y = qRound(row / dpr);
    QTest::mouseClick(view.viewport(), Qt::LeftButton, Qt::NoModifier, QPoint(qFloor(expectedLeft) - 3, y));
    QCOMPARE(requested.count(), 0);
    QTest::mouseClick(view.viewport(), Qt::LeftButton, Qt::NoModifier, QPoint(qCeil(expectedLeft) + 3, y));
    QCOMPARE(requested.count(), 1);
    QTest::mouseClick(view.viewport(), Qt::LeftButton, Qt::NoModifier, QPoint(qCeil(expectedLeft + expected) + 3, y));
    QCOMPARE(requested.count(), 1);
  }
  void emptyOpenActionSupportsKeyboardAndAccessibility(){
    DocumentView view;view.show();view.setEmptyState();QSignalSpy requested(&view,&DocumentView::openRequested);view.setFocus();QTest::keyClick(&view,Qt::Key_Return);QCOMPARE(requested.count(),1);QTest::keyClick(&view,Qt::Key_Space);QCOMPARE(requested.count(),2);QCOMPARE(view.accessibleName(),QString::fromUtf8("打开"));
    view.setErrorState("ISOLATED_ERROR");QVERIFY(view.accessibleDescription().contains("ISOLATED_ERROR"));QCOMPARE(view.accessibleName(),QString::fromUtf8("重新选择"));QTest::keyClick(&view,Qt::Key_Return);QCOMPARE(requested.count(),3);
  }
  void webpAuthorizedBytesDecodeAndRender() {
    const QByteArray bytes=QByteArray::fromBase64("UklGRhwAAABXRUJQVlA4TA8AAAAvF8AFAAcQ/Y/+ByKi/wEA");
    QVERIFY2(QImageReader::supportedImageFormats().contains("webp"),"Install the matching official Qt qtimageformats module; WebP must not silently become a missing image.");
    const QByteArray original=bytes;const QByteArray decodeView=imageDecode::inputBytes(bytes);QCOMPARE(bytes,original);QCOMPARE(decodeView.size(),40);QCOMPARE(decodeView.left(bytes.size()),bytes);
    QBuffer buffer;buffer.setData(decodeView);QVERIFY(buffer.open(QIODevice::ReadOnly));QImageReader reader(&buffer,"webp");const QImage decoded=reader.read();QVERIFY2(!decoded.isNull(),qPrintable(reader.errorString()));QCOMPARE(decoded.size(),QSize(24,24));QCOMPARE(decoded.pixelColor(12,12),QColor(Qt::red));
    QByteArray truncated=bytes.left(bytes.size()-8);QCOMPARE(imageDecode::inputBytes(truncated),truncated);
    QByteArray badSignature=bytes;badSignature[0]='X';QCOMPARE(imageDecode::inputBytes(badSignature),badSignature);
    QByteArray badPayload=bytes;badPayload[20]=0;
    for(const QByteArray& invalid:{truncated,badSignature,badPayload}) {QBuffer bad;bad.setData(imageDecode::inputBytes(invalid));QVERIFY(bad.open(QIODevice::ReadOnly));QImageReader badReader(&bad,"webp");QVERIFY(badReader.read().isNull());}
    QFile imageFile(files_.filePath("authorized.webp"));QVERIFY(imageFile.open(QIODevice::WriteOnly));QCOMPARE(imageFile.write(bytes),qint64(bytes.size()));imageFile.close();const auto path=fixture("![webp](authorized.webp)\n\nBody\n");
    const auto payload=bridge::readImage(path,"authorized.webp");QVERIFY(payload.value("ok").toBool());QCOMPARE(payload.value("mime").toString(),QString("image/webp"));QVERIFY(!payload.contains("path"));
    DocumentView view;view.resize(820,900);view.show();view.setPlan(bridge::planFor("![webp](authorized.webp)\n\nBody\n").value("plan").toObject(),path);QCoreApplication::processEvents();const QImage shot=view.viewport()->grab().toImage().convertToFormat(QImage::Format_RGB32);int red=0;for(int y=0;y<shot.height();++y){const QRgb* row=reinterpret_cast<const QRgb*>(shot.constScanLine(y));for(int x=0;x<shot.width();++x)if(qRed(row[x])>200&&qGreen(row[x])<50&&qBlue(row[x])<50)++red;}QVERIFY(red>=100);QVERIFY(!view.hasPendingEdits());QCOMPARE(read(imageFile.fileName()),original);QCOMPARE(read(path),QByteArray("![webp](authorized.webp)\n\nBody\n"));
  }
  void documentLifecycleDropsOldContentAndUndo() {
    const QString sourceFile=QDir(QString::fromUtf8(QT_TESTCASE_BUILDDIR)).absoluteFilePath(QString::fromUtf8(__FILE__));QFile input(QFileInfo(sourceFile).absoluteDir().absoluteFilePath("../../tests/fixtures/performance/large.md"));QVERIFY(input.open(QIODevice::ReadOnly));const QString large=QString::fromUtf8(input.readAll());
    DocumentView view;view.resize(820,900);view.show();const auto first=fixture("Small first\n"),second=fixture("Small second\n");
    view.setPlan(bridge::planFor(large).value("plan").toObject(),first);QVERIFY(view.document()->characterCount()>10000);
    view.setPlan(bridge::planFor("Small first\n").value("plan").toObject(),first);QVERIFY(!view.document()->toPlainText().contains("AUDIT_LARGE_BEGIN"));QVERIFY(!view.hasPendingEdits());
    view.setPlan(bridge::planFor("Small second\n").value("plan").toObject(),second);QVERIFY(view.revealText("second"));view.setFocus();QTest::keyClick(&view,Qt::Key_Right);QTest::keyClicks(&view,"edit");QVERIFY(view.hasPendingEdits());
    view.setEmptyState();QCOMPARE(view.document()->toPlainText(),QString());QVERIFY(!view.document()->isUndoAvailable());QVERIFY(!view.hasPendingEdits());
    view.setPlan(bridge::planFor("Small second\n").value("plan").toObject(),second);QVERIFY(view.revealText("second"));QTest::keyClick(&view,Qt::Key_Right);QTest::keyClicks(&view,"reopened");QVERIFY(view.hasPendingEdits());QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QVERIFY(!view.hasPendingEdits());QCOMPARE(read(second),QByteArray("Small second\n"));
  }
  void wholeAppLargeTypingLatency() {
    const QString sourceFile=QDir(QString::fromUtf8(QT_TESTCASE_BUILDDIR)).absoluteFilePath(QString::fromUtf8(__FILE__));QFile input(QFileInfo(sourceFile).absoluteDir().absoluteFilePath("../../tests/fixtures/performance/large.md"));QVERIFY(input.open(QIODevice::ReadOnly));const auto bytes=input.readAll();
    for(int stage=0;stage<4;++stage){
      const auto path=fixture(bytes);MainWindow w;show(w,path);auto* view=doc(w);QVector<int> positions;int tailTable=-1;QTextCursor match(view->document());while(!(match=view->document()->find("mixed text",match)).isNull()){if(match.currentTable())tailTable=match.selectionEnd();else positions.append(match.selectionEnd());}QVERIFY(positions.size()>3);QVERIFY(tailTable>=0);
      const int at=stage==3?tailTable:positions[stage==0?0:stage==1?positions.size()/2:positions.size()-1];view->restoreSelectionState({at,at});view->setFocus();QTest::keyClick(view,Qt::Key_Right);QTest::keyClick(view,Qt::Key_Left);w.grab();
      QVector<double> samples,eventPaint,idleActual;QElapsedTimer duration;duration.start();int keys=0;
      while(duration.elapsed()<1500){QElapsedTimer cycle;cycle.start();QTest::keyClick(view,Qt::Key_X);QCoreApplication::processEvents();w.grab();eventPaint.append(cycle.nsecsElapsed()/1000000.0);QElapsedTimer idle;idle.start();QTest::qWait(20);idleActual.append(idle.nsecsElapsed()/1000000.0);samples.append(cycle.nsecsElapsed()/1000000.0);++keys;}
      save(w);QVERIFY(read(path)!=bytes);for(int i=0;i<keys+3 && view->hasPendingEdits();++i)QTest::keyClick(view,Qt::Key_Z,Qt::ControlModifier);QVERIFY(!view->hasPendingEdits());save(w);QCOMPARE(read(path),bytes);
      std::sort(eventPaint.begin(),eventPaint.end());std::sort(idleActual.begin(),idleActual.end());auto percentile=[](const QVector<double>& values){return values[qMin(values.size()-1,qsizetype(std::ceil(values.size()*0.95))-1)];};
      qInfo().noquote()<<QString("WHOLE_APP_PROFILE stage=%1 event_plus_Qt_paint_p95_ms=%2 event_plus_Qt_paint_max_ms=%3 requested_idle_ms=20 actual_idle_p95_ms=%4 actual_idle_max_ms=%5").arg(stage).arg(percentile(eventPaint),0,'f',2).arg(eventPaint.last(),0,'f',2).arg(percentile(idleActual),0,'f',2).arg(idleActual.last(),0,'f',2);
      std::sort(samples.begin(),samples.end());const double p95=samples[qMin(samples.size()-1,int(std::ceil(samples.size()*0.95))-1)];
      qInfo().noquote()<<QString("WHOLE_APP_LATENCY stage=%1 (0=first-paragraph,1=middle-paragraph,2=last-paragraph,3=last-table) platform=%2 keys=%3 duration_ms=%4 cycle_p95_ms=%5 cycle_max_ms=%6 explicit_idle_ms=20 includes_MainWindow_timers=true includes_Qt_grab=true DWM=false").arg(stage).arg(QGuiApplication::platformName()).arg(keys).arg(duration.elapsed()).arg(p95,0,'f',2).arg(samples.last(),0,'f',2);
    }
  }
  void structuredLargeFixtureReturnsToEventLoop() {
    const QString sourceFile=QDir(QString::fromUtf8(QT_TESTCASE_BUILDDIR)).absoluteFilePath(QString::fromUtf8(__FILE__));
    const QString fixturePath=QFileInfo(sourceFile).absoluteDir().absoluteFilePath("../../tests/fixtures/performance/large.md");
    QFile input(fixturePath);QVERIFY2(input.open(QIODevice::ReadOnly),qPrintable(fixturePath));const QByteArray bytes=input.readAll();QCOMPARE(bytes.size(),2*1024*1024);const auto path=fixture(bytes);
    const QString token=QUuid::createUuid().toString();const QString statePath=files_.filePath(token+".json");QProcessEnvironment env=QProcessEnvironment::systemEnvironment();
    env.insert("VELLORA_TEST_INSTANCE",token);env.insert("QT_QPA_PLATFORM","offscreen");env.insert("VELLORA_SCREENSHOT",files_.filePath(token+".png"));env.insert("VELLORA_TEST_STATE",statePath);
    env.remove("VELLORA_DIALOG");env.remove("VELLORA_SEARCH");env.remove("VELLORA_DEBUG_TREE");env.remove("VELLORA_TEST_OBSERVE");
    QProcess process;process.setProcessEnvironment(env);process.start(QDir(QCoreApplication::applicationDirPath()).absoluteFilePath("../test-app/vellora.exe"),{path});QVERIFY(process.waitForStarted(5000));
    QVERIFY2(process.waitForFinished(15000),"Structured 2MiB fixture blocked the product event loop for over 15 seconds");QCOMPARE(process.exitStatus(),QProcess::NormalExit);QCOMPARE(process.exitCode(),0);
    const QJsonObject state=QJsonDocument::fromJson(read(statePath)).object();
    QCOMPARE(state.value("title").toString(),QString("Vellora"));
    QString expectedSource=QString::fromUtf8(bytes);expectedSource.replace("\r\n","\n");
    QCOMPARE(state.value("sourceText").toString(),expectedSource);
    QVERIFY(state.value("documentText").toString().size()>10000);QCOMPARE(read(path),bytes);
  }
  void singleInstanceForwardsDocument_data() {
    QTest::addColumn<QString>("sourceFlag");
    QTest::newRow("source-flag") << QString("--source");
    QTest::newRow("source-mode-alias") << QString("--source-mode");
  }
  void singleInstanceForwardsDocument() {
    QFETCH(QString, sourceFlag);
    const QString executable = QDir(QCoreApplication::applicationDirPath()).absoluteFilePath("../test-app/vellora.exe");
    QVERIFY2(QFileInfo::exists(executable), qPrintable(executable));
    const auto a = fixture("# FIRST_PROCESS\n"); const auto b = fixture("# FORWARDED_DOCUMENT\n");
    const QString token = QUuid::createUuid().toString();
    const QString statePath = files_.filePath(token + ".json");
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("VELLORA_TEST_INSTANCE", token); env.insert("QT_QPA_PLATFORM", "offscreen");
    env.insert("VELLORA_SCREENSHOT", files_.filePath(token + ".png")); env.insert("VELLORA_TEST_STATE", statePath);
    env.remove("VELLORA_DIALOG"); env.remove("VELLORA_SEARCH"); env.remove("VELLORA_DEBUG_TREE");
    QProcess primary; primary.setProcessEnvironment(env); primary.start(executable, {a}); QVERIFY(primary.waitForStarted(5000));
    // Probe only this test's random endpoint. Never contact the user's instance.
    const QString serverName = "vellora.qt.preview." + QString::fromLatin1(QCryptographicHash::hash((QDir::homePath() + token).toUtf8(), QCryptographicHash::Sha256).toHex().left(24));
    QElapsedTimer deadline; deadline.start(); bool ready = false;
    while (deadline.elapsed() < 1800 && !ready) {
      QLocalSocket probe; probe.connectToServer(serverName); ready = probe.waitForConnected(100); probe.disconnectFromServer();
      if (!ready) QTest::qWait(20);
    }
    QVERIFY2(ready, primary.readAllStandardError().constData());
    QProcess secondary; secondary.setProcessEnvironment(env); secondary.start(executable, {b, sourceFlag});
    QVERIFY(secondary.waitForStarted(5000)); QVERIFY(secondary.waitForFinished(1800)); QCOMPARE(secondary.exitStatus(), QProcess::NormalExit); QCOMPARE(secondary.exitCode(), 0);
    QVERIFY(primary.waitForFinished(6000)); QCOMPARE(primary.exitStatus(), QProcess::NormalExit); QCOMPARE(primary.exitCode(), 0);
    const QJsonObject state = QJsonDocument::fromJson(read(statePath)).object(); QVERIFY(!state.isEmpty());
    QVERIFY(state.value("sourceVisible").toBool()); QCOMPARE(state.value("sourceText").toString(), QString("# FORWARDED_DOCUMENT\n"));
    QCOMPARE(state.value("title").toString(),QString("Vellora"));
    QVERIFY(state.value("documentText").toString().contains("FORWARDED_DOCUMENT"));
    QVERIFY(!state.value("documentText").toString().contains("FIRST_PROCESS"));
    QCOMPARE(read(a), QByteArray("# FIRST_PROCESS\n")); QCOMPARE(read(b), QByteArray("# FORWARDED_DOCUMENT\n"));
  }
  void imeCommitSaves() {
    const auto path = fixture("Body\n"); MainWindow w; show(w, path); QVERIFY(doc(w)->revealText("Body")); doc(w)->setFocus(); QTest::keyClick(doc(w), Qt::Key_Right);
    const QString committed = QString::fromUtf8("\xe4\xb8\xad\xe6\x96\x87");
    QInputMethodEvent preview(committed, {}); QApplication::sendEvent(doc(w), &preview); QVERIFY(doc(w)->isComposing());
    save(w); QCOMPARE(read(path), QByteArray("Body\n"));
    QInputMethodEvent commit; commit.setCommitString(committed); QApplication::sendEvent(doc(w), &commit); QVERIFY(!doc(w)->isComposing()); save(w);
    QCOMPARE(read(path), QString("Body" + committed + "\n").toUtf8());
  }
};
QTEST_MAIN(NativeRegressions)
#include "regressions.moc"




















