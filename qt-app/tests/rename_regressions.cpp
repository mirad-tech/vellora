#include <QtWidgets>
#include <QtTest>
#include "bridge.h"
#include "chrome.h"
#include "document_view.h"
#include "main_window.h"

// Renaming the open document, or a folder that contains it, must not reopen it:
// the draft, undo history and dirty state stay, and saves and image reads follow
// the new path.
class RenameRegressions : public QObject {
  Q_OBJECT
  QTemporaryDir files_;

  QString write(const QString& relative, const QByteArray& bytes) {
    const QString path = files_.filePath(relative);
    if (!QDir().mkpath(QFileInfo(path).absolutePath())) qFatal("fixture folder");
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size()) qFatal("fixture write");
    return path;
  }
  static void waitIdle(MainWindow& w) {
    QElapsedTimer timer; timer.start();
    while (w.isAsyncBusy() && timer.elapsed() < 10000) {
      QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
    }
    QCoreApplication::processEvents();
  }
  static void openDocument(MainWindow& w, const QString& path) {
    w.show(); w.activateWindow(); QTest::qWait(20);
    w.openPath(path); waitIdle(w);
  }
  static void editBody(MainWindow& w) {
    auto* view = w.findChild<DocumentView*>();
    if (!view->revealText(QStringLiteral("body"))) qFatal("body text not found");
    QTest::keyClick(view, Qt::Key_Right);
    QTest::keyClicks(view, "LOCAL");
  }
  static QString draft(MainWindow& w) { QString text; w.splicePendingEdits(&text); return text; }
  static QString readAll(const QString& path) {
    QFile file(path);
    return file.open(QIODevice::ReadOnly) ? QString::fromUtf8(file.readAll()) : QString();
  }
  static bool endsWithPath(const QString& path, const QString& suffix) {
    return QDir::fromNativeSeparators(path).endsWith(suffix, Qt::CaseInsensitive);
  }

 private slots:
  void initTestCase() { QVERIFY(files_.isValid()); QApplication::setQuitOnLastWindowClosed(false); }

  void renamingTheOpenFileKeepsDraftAndUndoAndSavesUnderTheNewName() {
    const QString path = write(QStringLiteral("file/note.md"), "# Title\n\nbody\n");
    MainWindow w; openDocument(w, path); editBody(w);
    auto* view = w.findChild<DocumentView*>();
    const QString local = draft(w);
    QVERIFY(local.contains(QStringLiteral("LOCAL")));
    QVERIFY(view->document()->isUndoAvailable());

    const QJsonObject result = w.renameEntry(path, QStringLiteral("renamed.md"));
    QVERIFY2(result.value("ok").toBool(), qPrintable(result.value("message").toString()));
    QVERIFY(!QFileInfo::exists(path));
    QVERIFY2(endsWithPath(w.documentPath(), QStringLiteral("/file/renamed.md")), qPrintable(w.documentPath()));
    QCOMPARE(view->documentPath(), w.documentPath());
    QCOMPARE(draft(w), local);
    QVERIFY(view->document()->isUndoAvailable());
    QVERIFY(bridge::sessionMatches(w.documentPath()).value("matches").toBool());

    emit w.findChild<Toolbar*>()->saveRequested();
    waitIdle(w);
    QVERIFY(readAll(files_.filePath(QStringLiteral("file/renamed.md"))).contains(QStringLiteral("LOCAL")));
    QVERIFY(!QFileInfo::exists(path));
  }

  void renamingTheParentFolderKeepsImagesResolvableAfterHide() {
    const QString path = write(QStringLiteral("folder/doc.md"), "# Title\n\nbody\n\n![dot](dot.png)\n");
    QImage dot(4, 4, QImage::Format_ARGB32);
    dot.fill(Qt::red);
    QVERIFY(dot.save(files_.filePath(QStringLiteral("folder/dot.png")), "PNG"));
    MainWindow w; openDocument(w, path); editBody(w);
    auto* view = w.findChild<DocumentView*>();
    const QString oldPath = w.documentPath();
    const QString local = draft(w);
    QVERIFY(bridge::statImage(oldPath, QStringLiteral("dot.png")).value("ok").toBool());

    const QJsonObject result = w.renameEntry(files_.filePath(QStringLiteral("folder")), QStringLiteral("moved"));
    QVERIFY2(result.value("ok").toBool(), qPrintable(result.value("message").toString()));
    QVERIFY(result.value("isDir").toBool());
    QVERIFY2(endsWithPath(w.documentPath(), QStringLiteral("/moved/doc.md")), qPrintable(w.documentPath()));
    QCOMPARE(view->documentPath(), w.documentPath());

    // Hiding drops the decoded-image cache, so the next paint re-reads the image
    // through the view's document path. It must resolve inside the new folder.
    w.hide(); QCoreApplication::processEvents(); w.show(); QTest::qWait(20);
    QVERIFY(bridge::statImage(view->documentPath(), QStringLiteral("dot.png")).value("ok").toBool());
    QVERIFY(!bridge::statImage(oldPath, QStringLiteral("dot.png")).value("ok").toBool());
    QCOMPARE(draft(w), local);
    QVERIFY(view->document()->isUndoAvailable());
  }

  void rejectedRenamesLeaveTheDocumentUntouched() {
    const QString path = write(QStringLiteral("clash/a.md"), "# Title\n\nbody\n");
    const QString other = write(QStringLiteral("clash/b.md"), "keep");
    MainWindow w; openDocument(w, path); editBody(w);
    const QString before = w.documentPath();
    const QString local = draft(w);

    QJsonObject result = w.renameEntry(path, QStringLiteral("b.md"));
    QVERIFY(!result.value("ok").toBool());
    QCOMPARE(result.value("code").toString(), QStringLiteral("TARGET_EXISTS"));
    result = w.renameEntry(path, QStringLiteral("bad?.md"));
    QCOMPARE(result.value("code").toString(), QStringLiteral("INVALID_NAME"));

    QCOMPARE(readAll(other), QStringLiteral("keep"));
    QVERIFY(QFileInfo::exists(path));
    QCOMPARE(w.documentPath(), before);
    QCOMPARE(draft(w), local);
  }

  void renameReturnsBusyDuringImeCompositionOrAsyncWork() {
    const QString path = write(QStringLiteral("busy/note.md"), "# Title\n\nbody\n");
    const QString other = write(QStringLiteral("busy/other.md"), "# Other\n");
    MainWindow w; openDocument(w, path);

    w.openPath(other);
    QVERIFY(w.isAsyncBusy());
    const QJsonObject asyncBlocked = w.renameEntry(path, QStringLiteral("async_blocked.md"));
    QVERIFY(!asyncBlocked.value("ok").toBool());
    QCOMPARE(asyncBlocked.value("code").toString(), QStringLiteral("BUSY"));
    waitIdle(w);
    QVERIFY(QFileInfo::exists(path));
    QVERIFY(!QFileInfo::exists(files_.filePath(QStringLiteral("busy/async_blocked.md"))));

    openDocument(w, path);
    auto* view = w.findChild<DocumentView*>();
    view->setFocus();
    QInputMethodEvent preedit(QStringLiteral("zhong"), {});
    QApplication::sendEvent(view, &preedit);
    QCoreApplication::processEvents();
    QVERIFY(view->isComposing());
    const QJsonObject imeBlocked = w.renameEntry(path, QStringLiteral("ime_blocked.md"));
    QVERIFY(!imeBlocked.value("ok").toBool());
    QCOMPARE(imeBlocked.value("code").toString(), QStringLiteral("BUSY"));
    QVERIFY(QFileInfo::exists(path));
    QVERIFY(!QFileInfo::exists(files_.filePath(QStringLiteral("busy/ime_blocked.md"))));

    QInputMethodEvent cancel;
    QApplication::sendEvent(view, &cancel);
    QCoreApplication::processEvents();
    QVERIFY(!view->isComposing());
  }

  void renamingParentFolderUpdatesRawSurfacePreviewDocumentPath() {
    const QString path = write(
        QStringLiteral("rawfolder/doc.md"),
        "# Title\n\n<figure><img src=\"dot.png\" alt=\"dot\" /></figure>\n");
    QImage dot(4, 4, QImage::Format_ARGB32);
    dot.fill(Qt::blue);
    QVERIFY(dot.save(files_.filePath(QStringLiteral("rawfolder/dot.png")), "PNG"));
    MainWindow w; openDocument(w, path);
    auto* view = w.findChild<DocumentView*>();
    const auto previews = view->findChildren<DocumentView*>();
    QVERIFY(!previews.isEmpty());
    const QString oldPath = w.documentPath();
    for (auto* preview : previews) {
      QCOMPARE(preview->documentPath(), oldPath);
    }

    const QJsonObject result =
        w.renameEntry(files_.filePath(QStringLiteral("rawfolder")), QStringLiteral("rawmoved"));
    QVERIFY2(result.value("ok").toBool(), qPrintable(result.value("message").toString()));
    QVERIFY2(endsWithPath(w.documentPath(), QStringLiteral("/rawmoved/doc.md")),
             qPrintable(w.documentPath()));
    for (auto* preview : previews) {
      QCOMPARE(preview->documentPath(), w.documentPath());
    }
    w.hide(); QCoreApplication::processEvents(); w.show(); QTest::qWait(20);
    QVERIFY(bridge::statImage(previews.first()->documentPath(), QStringLiteral("dot.png"))
                .value("ok")
                .toBool());
    QVERIFY(!bridge::statImage(oldPath, QStringLiteral("dot.png")).value("ok").toBool());
  }
};
QTEST_MAIN(RenameRegressions)
#include "rename_regressions.moc"
