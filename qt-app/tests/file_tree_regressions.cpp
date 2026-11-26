#include <QtWidgets>
#include <QtTest>
#include <QScopeGuard>
#include <QSettings>
#include "app_settings.h"
#include "bridge.h"
#include "chrome.h"
#include "document_view.h"
#include "file_tree_panel.h"
#include "main_window.h"
#include "theme.h"
#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif

// One sidebar holds the file panel and the outline behind two tabs and one
// toolbar toggle. Every change made from it goes through MainWindow: switching
// keeps unsaved work safe, and renames keep the open session.
class FileTreeRegressions : public QObject {
  Q_OBJECT
  QTemporaryDir files_;
  int sequence_ = 0;
  QTimer dialogTimer_;
  QStringList dialogs_;
  QString answer_;
  // Answers for the next dialogs, in order; answer_ applies once these run out.
  QStringList answers_;
  // Every deletion handed to the shell, which tests replace.
  QVector<QPair<QString, bool>> deletes_;
  bool notRecyclable_ = false;

  QString folder() {
    const QString path = files_.filePath(QStringLiteral("case%1").arg(++sequence_));
    if (!QDir().mkpath(path)) qFatal("fixture folder");
    // Use the core's spelling (long names): a CI temp folder is often an 8.3
    // short path, while the session reports the canonical one.
    const QJsonObject probe = bridge::createMarkdown(path, QStringLiteral("probe.md"));
    if (!probe.value("ok").toBool()) qFatal("fixture probe");
    const QString canonical = FileTreePanel::normalizedPath(probe.value("path").toString());
    if (!QFile::remove(canonical)) qFatal("fixture probe cleanup");
    return QFileInfo(canonical).absolutePath();
  }
  static void write(const QString& path, const QByteArray& bytes) {
    if (!QDir().mkpath(QFileInfo(path).absolutePath())) qFatal("fixture folder");
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size()) qFatal("fixture write");
  }
  static QString readAll(const QString& path) {
    QFile file(path);
    return file.open(QIODevice::ReadOnly) ? QString::fromUtf8(file.readAll()) : QString();
  }
  static void waitIdle(MainWindow& w) {
    QElapsedTimer timer; timer.start();
    while (w.isAsyncBusy() && timer.elapsed() < 10000) QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
    QCoreApplication::processEvents();
  }
  static SidePanel* side(MainWindow& w) { return w.findChild<SidePanel*>(); }
  static FileTreePanel* panel(MainWindow& w) { return w.findChild<FileTreePanel*>(); }
  static QToolButton* named(QWidget* parent, const QString& name) {
    for (auto* button : parent->findChildren<QToolButton*>()) if (button->accessibleName() == name) return button;
    return nullptr;
  }
  static void start(MainWindow& w) {
    // Docked: the sidebar floats below 1024 px, like the original outline.
    w.resize(1200, 700); w.show(); w.activateWindow(); QTest::qWait(20);
    side(w)->setCurrentTab(SidePanel::Files);
    if (!side(w)->isVisible()) w.toggleSidebar();
  }
  static bool listed(MainWindow& w, const QString& path) {
    const QModelIndex index = panel(w)->indexForPath(path);
    if (!index.isValid()) return false;
    panel(w)->tree()->scrollTo(index);
    return !panel(w)->tree()->visualRect(index).isEmpty();
  }
  static void click(MainWindow& w, const QString& path) {
    auto* tree = panel(w)->tree();
    QTest::mouseClick(tree->viewport(), Qt::LeftButton, {}, tree->visualRect(panel(w)->indexForPath(path)).center());
  }
  static void editBody(MainWindow& w) {
    auto* view = w.findChild<DocumentView*>();
    if (!view->revealText(QStringLiteral("body"))) qFatal("body text not found");
    QTest::keyClick(view, Qt::Key_Right);
    QTest::keyClicks(view, "LOCAL");
  }
  static QString draft(MainWindow& w) { QString text; w.splicePendingEdits(&text); return text; }
  // Drags `source` over the row of `onto` (below the last row when empty) and
  // drops it there, as the panel's own drag does. True when the drop was taken.
  static bool dropOn(MainWindow& w, const QString& source, const QString& onto,
                     const QString& format = FileTreePanel::moveMimeType()) {
    QTreeView* tree = panel(w)->tree();
    QPoint position(20, tree->viewport()->height() - 4);
    if (!onto.isEmpty()) {
      const QModelIndex index = panel(w)->indexForPath(onto);
      if (!index.isValid()) qFatal("drop target is not listed");
      tree->scrollTo(index);
      position = tree->visualRect(index).center();
    }
    QMimeData data;
    data.setData(format, source.toUtf8());
    QDragEnterEvent enter(position, Qt::MoveAction, &data, Qt::LeftButton, Qt::NoModifier);
    QApplication::sendEvent(tree->viewport(), &enter);
    QDragMoveEvent hover(position, Qt::MoveAction, &data, Qt::LeftButton, Qt::NoModifier);
    QApplication::sendEvent(tree->viewport(), &hover);
    const bool accepted = hover.isAccepted();
    QDropEvent drop(QPointF(position), Qt::MoveAction, &data, Qt::LeftButton, Qt::NoModifier);
    QApplication::sendEvent(tree->viewport(), &drop);
    return accepted && drop.isAccepted();
  }

 private slots:
  void initTestCase() {
    QVERIFY(files_.isValid());
    QApplication::setQuitOnLastWindowClosed(false);
    // Answers each modal once: the button named by answers_ or answer_, otherwise Esc.
    connect(&dialogTimer_, &QTimer::timeout, this, [this] {
      for (auto* widget : QApplication::allWidgets()) {
        auto* dialog = qobject_cast<ModalDialog*>(widget);
        if (!dialog || !dialog->isVisible() || dialog->property("answered").toBool()) continue;
        dialog->setProperty("answered", true);
        QStringList labels;
        QPushButton* target = nullptr;
        const QString wanted = answers_.isEmpty() ? answer_ : answers_.takeFirst();
        for (auto* button : dialog->findChildren<QPushButton*>()) {
          labels << button->text();
          if (button->text() == wanted) target = button;
        }
        dialogs_ << labels.join(QLatin1Char('|'));
        if (target) target->click();
        else QTest::keyClick(dialog, Qt::Key_Escape);
      }
    });
    dialogTimer_.start(10);
    // Never the real recycle bin: deletions are recorded and carried out here.
    bridge::setDiskDeleterForTesting([this](const QString& path, bool permanent) {
      deletes_.append({path, permanent});
      if (notRecyclable_ && !permanent) return 1;
      const bool removed = QFileInfo(path).isDir() ? QDir(path).removeRecursively() : QFile::remove(path);
      return removed ? 0 : static_cast<int>(0x80004005u);
    });
  }
  void cleanupTestCase() { bridge::setDiskDeleterForTesting({}); }
  void init() {
    dialogs_.clear();
    answer_.clear();
    answers_.clear();
    deletes_.clear();
    notRecyclable_ = false;
  }

  void pathsFromTheCoreCompareEqual() {
#ifdef Q_OS_WIN
    QVERIFY(FileTreePanel::samePath(QStringLiteral("\\\\?\\C:\\Notes\\a.md"), QStringLiteral("C:/Notes/a.md")));
#else
    QVERIFY(FileTreePanel::samePath(QStringLiteral("/home/u/Notes/./a.md"), QStringLiteral("/home/u/Notes/a.md")));
    QVERIFY(FileTreePanel::isInside(QStringLiteral("/home/u/Notes/sub/a.md"), QStringLiteral("/home/u/Notes")));
    QVERIFY(!FileTreePanel::isInside(QStringLiteral("/home/u/Notes2/a.md"), QStringLiteral("/home/u/Notes")));
#endif
    QVERIFY(FileTreePanel::isInside(QStringLiteral("C:/Notes/sub/a.md"), QStringLiteral("C:/Notes")));
    QVERIFY(!FileTreePanel::isInside(QStringLiteral("C:/Notes2/a.md"), QStringLiteral("C:/Notes")));
    QVERIFY(!FileTreePanel::isInside(QStringLiteral("C:/Notes"), QStringLiteral("C:/Notes")));
#ifdef Q_OS_WIN
    QVERIFY(FileTreePanel::samePath(QStringLiteral("c:/notes/A.md"), QStringLiteral("C:/Notes/a.md")));
#endif
  }

  void shortWindowsPathsMatchTheCoreSpelling() {
#ifndef Q_OS_WIN
    QSKIP("8.3 short names exist only on Windows");
#else
    QCOMPARE(FileTreePanel::expandedPath(QStringLiteral("C:\\Notes\\a.md")), QStringLiteral("C:/Notes/a.md"));
    const QString dir = folder();
    const QString longFolder = dir + QStringLiteral("/Long Folder Name");
    write(longFolder + "/note.md", "# Note\n\nbody\n");
    const std::wstring native = QDir::toNativeSeparators(longFolder).toStdWString();
    wchar_t buffer[4096];
    const DWORD length = GetShortPathNameW(native.c_str(), buffer, DWORD(sizeof(buffer) / sizeof(buffer[0])));
    const QString shortFolder =
        length > 0 ? FileTreePanel::normalizedPath(QString::fromWCharArray(buffer, int(length))) : QString();
    if (!shortFolder.contains(QLatin1Char('~'))) QSKIP("This volume does not generate 8.3 short names");
    QVERIFY(!FileTreePanel::samePath(shortFolder, longFolder));
    QVERIFY(FileTreePanel::samePath(FileTreePanel::expandedPath(shortFolder), longFolder));
    // A path that does not exist yet keeps its tail and expands the rest.
    QVERIFY(FileTreePanel::samePath(FileTreePanel::expandedPath(shortFolder + "/missing/new.md"),
                                    longFolder + "/missing/new.md"));

    MainWindow w; start(w);
    w.openFolder(shortFolder);
    QVERIFY2(FileTreePanel::samePath(panel(w)->rootPath(), longFolder), qPrintable(panel(w)->rootPath()));
    // The core reports the long spelling. With a short root the file would not
    // count as inside it, and the tree would jump to the file's own folder.
    w.openPath(shortFolder + "/note.md"); waitIdle(w);
    QVERIFY2(FileTreePanel::samePath(panel(w)->rootPath(), longFolder), qPrintable(panel(w)->rootPath()));
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, longFolder + "/note.md"), 5000);
    QVERIFY(panel(w)->isCurrentIndex(panel(w)->indexForPath(longFolder + "/note.md")));
#endif
  }

  void oneToggleOpensTheSidebarWithFilesAndOutline() {
    MainWindow w; w.resize(1200, 700); w.show(); QTest::qWait(20);
    auto* sidebar = side(w);
    QVERIFY(sidebar);
    // Files and outline live in the one sidebar: no second panel, no second toggle.
    QCOMPARE(w.findChildren<OutlinePanel*>().size(), 1);
    QVERIFY(sidebar->isAncestorOf(w.findChild<OutlinePanel*>()));
    QVERIFY(sidebar->isAncestorOf(panel(w)));
    QToolButton* toggle = named(w.findChild<Toolbar*>(), QStringLiteral("侧边栏"));
    QVERIFY(toggle);
    QVERIFY(!named(w.findChild<Toolbar*>(), QStringLiteral("目录")));
    QVERIFY(toggle->isEnabled());
    QVERIFY(!sidebar->isVisible());

    toggle->click();
    QVERIFY(sidebar->isVisible());
    QVERIFY(toggle->isChecked());
    QVERIFY(!sidebar->isFloating());
    QCOMPARE(sidebar->geometry().left(), 0);
    QVERIFY(!sidebar->graphicsEffect());
    QCOMPARE(sidebar->currentTab(), SidePanel::Files);
    QVERIFY(named(sidebar, QStringLiteral("文件")));
    QToolButton* outlineTab = named(sidebar, QStringLiteral("大纲"));
    QVERIFY(outlineTab);
    // No document yet: the outline tab waits, and the file panel offers a folder.
    QVERIFY(!outlineTab->isEnabled());
    bool offered = false;
    for (auto* button : sidebar->findChildren<QPushButton*>()) {
      offered = offered || (button->isVisible() && button->text() == QStringLiteral("打开文件夹"));
    }
    QVERIFY(offered);

    // Below 1024 px it floats over the document and stays open.
    w.resize(900, 700);
    QTRY_VERIFY(sidebar->isFloating());
    QVERIFY(sidebar->isVisible());
    QVERIFY(toggle->isChecked());
    QCOMPARE(sidebar->geometry().topLeft(), QPoint(12, 8));
    QCOMPARE(sidebar->width(), 248);
    QVERIFY(sidebar->graphicsEffect());
    w.resize(1200, 700);
    QTRY_VERIFY(!sidebar->isFloating());
    QVERIFY(sidebar->isVisible());
    QVERIFY(toggle->isChecked());
    QCOMPARE(sidebar->width(), 232);
    toggle->click();
    QVERIFY(!sidebar->isVisible());
    QVERIFY(!toggle->isChecked());
  }

  void outlineTabShowsTheDocumentAndReleasesTheFileWatch() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    write(a, "# First\n\nbody\n\n## Second\n");
    MainWindow w; start(w);
    QToolButton* outlineTab = named(side(w), QStringLiteral("大纲"));
    QVERIFY(outlineTab);
    QVERIFY(!outlineTab->isEnabled());
    w.openPath(a); waitIdle(w);
    QVERIFY(outlineTab->isEnabled());
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->findChild<QFileSystemModel*>(), 5000);

    outlineTab->click();
    QCOMPARE(side(w)->currentTab(), SidePanel::Outline);
    auto* outline = w.findChild<OutlinePanel*>();
    QTRY_VERIFY(outline->isVisible());
    QVERIFY(!panel(w)->isVisible());
    // A hidden file panel holds no directory watches.
    QVERIFY(!panel(w)->findChild<QFileSystemModel*>());
    const auto labels = [outline] {
      QStringList texts;
      for (auto* button : outline->findChildren<QPushButton*>()) if (button->isVisible()) texts << button->text();
      return texts;
    };
    QTRY_COMPARE(labels(), (QStringList{QStringLiteral("First"), QStringLiteral("Second")}));

    named(side(w), QStringLiteral("文件"))->click();
    QCOMPARE(side(w)->currentTab(), SidePanel::Files);
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->findChild<QFileSystemModel*>(), 5000);
    w.toggleSidebar();
    QVERIFY(!side(w)->isVisible());
    QVERIFY(!panel(w)->findChild<QFileSystemModel*>());
  }

  void floatingSidebarClosesWithEscapeOrAnOutsideClick() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    write(a, "# A\n\nbody\n");
    MainWindow w; w.resize(900, 700); w.show(); w.activateWindow(); QTest::qWait(20);
    w.openPath(a); waitIdle(w);
    w.toggleSidebar();
    QVERIFY(side(w)->isVisible());
    QVERIFY(side(w)->isFloating());
    QTest::keyClick(&w, Qt::Key_Escape);
    QVERIFY(!side(w)->isVisible());
    w.toggleSidebar();
    QVERIFY(side(w)->isVisible());
    auto* view = w.findChild<DocumentView*>();
    QTest::mouseClick(view->viewport(), Qt::LeftButton, {}, QPoint(view->viewport()->width() - 24, 24));
    QVERIFY(!side(w)->isVisible());
  }

  void openingAFileListsItsFolderWithoutNoise() {
    const QString dir = folder();
    write(dir + "/a.md", "# A\n\nbody\n");
    write(dir + "/b.markdown", "# B\n");
    write(dir + "/notes.txt", "x");
    write(dir + "/.hidden/x.md", "x");
    write(dir + "/sub/c.md", "# C\n");
    MainWindow w; start(w);
    w.openPath(dir + "/a.md"); waitIdle(w);
    QVERIFY2(FileTreePanel::samePath(panel(w)->rootPath(), dir), qPrintable(panel(w)->rootPath()));
    QTRY_COMPARE_WITH_TIMEOUT(panel(w)->visibleChildNames(dir),
                              (QStringList{QStringLiteral("sub"), QStringLiteral("a.md"), QStringLiteral("b.markdown")}), 5000);
    QVERIFY(panel(w)->isCurrentIndex(panel(w)->indexForPath(dir + "/a.md")));
  }

  void clickingSwitchesAndAnUnsavedDocumentOffersSaveAndSwitch() {
    const QString dir = folder();
    const QString a = dir + "/a.md", b = dir + "/b.md";
    write(a, "# A\n\nbody\n");
    write(b, "# B\n\nother\n");
    MainWindow w; start(w);
    w.openPath(a); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, b), 5000);
    editBody(w);
    const QString local = draft(w);

    answer_ = QStringLiteral("继续编辑");
    click(w, b); waitIdle(w);
    QCOMPARE(dialogs_.size(), 1);
    QVERIFY2(dialogs_.first().contains(QStringLiteral("保存并切换")), qPrintable(dialogs_.first()));
    QVERIFY(dialogs_.first().contains(QStringLiteral("放弃更改")));
    QVERIFY(FileTreePanel::samePath(w.documentPath(), a));
    QCOMPARE(draft(w), local);

    answer_ = QStringLiteral("保存并切换");
    click(w, b); waitIdle(w);
    QCOMPARE(dialogs_.size(), 2);
    QVERIFY(FileTreePanel::samePath(w.documentPath(), b));
    QVERIFY(readAll(a).contains(QStringLiteral("LOCAL")));
    QVERIFY(panel(w)->isCurrentIndex(panel(w)->indexForPath(b)));
    // Switching documents keeps the sidebar open on the files.
    QVERIFY(side(w)->isVisible());
    QCOMPARE(side(w)->currentTab(), SidePanel::Files);

    click(w, a); waitIdle(w);
    QCOMPARE(dialogs_.size(), 2);
    QVERIFY(FileTreePanel::samePath(w.documentPath(), a));
  }

  void renamingAnExpandedFolderKeepsTheSessionAndExpansion() {
    const QString dir = folder();
    const QString c = dir + "/sub/deep/c.md";
    write(c, "# C\n\nbody\n");
    MainWindow w; start(w);
    w.openFolder(dir);
    w.openPath(c); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->isExpandedIndex(panel(w)->indexForPath(dir + "/sub/deep")), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, c), 5000);
    editBody(w);
    const QString local = draft(w);

    // Expanded folders are watched; Windows refuses to rename a watched folder.
    emit panel(w)->renameRequested(dir + "/sub", QStringLiteral("moved"));
    QCOMPARE(dialogs_, QStringList());
    QVERIFY(QFileInfo::exists(dir + "/moved/deep/c.md"));
    QVERIFY(!QFileInfo::exists(dir + "/sub"));
    QVERIFY2(FileTreePanel::samePath(w.documentPath(), dir + "/moved/deep/c.md"), qPrintable(w.documentPath()));
    QCOMPARE(draft(w), local);
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->isExpandedIndex(panel(w)->indexForPath(dir + "/moved/deep")), 5000);
  }

  void inlineRenameCommitsWithEnterAndCancelsWithEscape() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    write(a, "# A\n\nbody\n");
    MainWindow w; start(w);
    w.openPath(a); waitIdle(w);
    panel(w)->beginRename(a);
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    QLineEdit* editor = panel(w)->renameEditor();
    QCOMPARE(editor->text(), QStringLiteral("a.md"));
    QCOMPARE(editor->selectedText(), QStringLiteral("a"));
    editor->selectAll();
    QTest::keyClicks(editor, "alpha.md");
    QTest::keyClick(editor, Qt::Key_Return);
    QVERIFY(!panel(w)->renameEditor());
    QCOMPARE(dialogs_, QStringList());
    QVERIFY(QFileInfo::exists(dir + "/alpha.md"));
    QVERIFY(FileTreePanel::samePath(w.documentPath(), dir + "/alpha.md"));

    panel(w)->beginRename(dir + "/alpha.md");
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    editor = panel(w)->renameEditor();
    QTest::keyClicks(editor, "zzz");
    QTest::keyClick(editor, Qt::Key_Escape);
    QVERIFY(!panel(w)->renameEditor());
    QVERIFY(side(w)->isVisible());
    QVERIFY(FileTreePanel::samePath(w.documentPath(), dir + "/alpha.md"));
    QVERIFY(QFileInfo::exists(dir + "/alpha.md"));
  }

  void newFileNeverReplacesAndOpensForNaming() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    write(a, "# A\n");
    write(dir + QStringLiteral("/未命名.md"), "keep");
    MainWindow w; start(w);
    w.openPath(a); waitIdle(w);
    emit panel(w)->newFileRequested(dir);
    waitIdle(w);
    const QString created = dir + QStringLiteral("/未命名 2.md");
    QVERIFY(QFileInfo::exists(created));
    QCOMPARE(readAll(dir + QStringLiteral("/未命名.md")), QStringLiteral("keep"));
    QVERIFY2(FileTreePanel::samePath(w.documentPath(), created), qPrintable(w.documentPath()));
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    QCOMPARE(panel(w)->renameEditor()->text(), QStringLiteral("未命名 2.md"));
    QTest::keyClick(panel(w)->renameEditor(), Qt::Key_Escape);
    QVERIFY(!panel(w)->renameEditor());
  }

  void clickingOutlineHeadingKeepsDockedSidebarOpenAndClosesFloatingSidebar() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    write(a, "# First\n\n## Second\n\nbody\n");
    MainWindow w; start(w);
    w.openPath(a); waitIdle(w);
    side(w)->setCurrentTab(SidePanel::Outline);
    QTRY_VERIFY_WITH_TIMEOUT(!side(w)->outline()->findChildren<QPushButton*>().isEmpty(), 5000);
    QVERIFY(!side(w)->isFloating());
    side(w)->outline()->findChildren<QPushButton*>().first()->click();
    QVERIFY(side(w)->isVisible());

    w.resize(700, 600);
    QCoreApplication::processEvents();
    if (!side(w)->isVisible()) emit w.findChild<Toolbar*>()->sidebarRequested();
    QVERIFY(side(w)->isVisible());
    QVERIFY(side(w)->isFloating());
    side(w)->setCurrentTab(SidePanel::Outline);
    QTRY_VERIFY_WITH_TIMEOUT(!side(w)->outline()->findChildren<QPushButton*>().isEmpty(), 5000);
    side(w)->outline()->findChildren<QPushButton*>().first()->click();
    QVERIFY(!side(w)->isVisible());
  }

  void preferredOutlineTabWaitsForDocumentAndRefreshesHeadingsOnOpen() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    write(a, "# Alpha\n\n## Beta\n");
    MainWindow w; start(w);
    side(w)->setCurrentTab(SidePanel::Outline);
    QCOMPARE(side(w)->preferredTab(), SidePanel::Outline);
    QCOMPARE(side(w)->currentTab(), SidePanel::Files);
    QVERIFY(side(w)->outline()->findChildren<QPushButton*>().isEmpty());

    w.openPath(a); waitIdle(w);
    QTRY_COMPARE_WITH_TIMEOUT(side(w)->currentTab(), SidePanel::Outline, 5000);
    QTRY_VERIFY_WITH_TIMEOUT(side(w)->outline()->findChildren<QPushButton*>().size() >= 2, 5000);
  }

  void shortcutsToggleSidebarAndSwitchToFilesTab() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    write(a, "# Heading\n\nbody\n");
    MainWindow w;
    w.resize(1000, 700); w.show(); w.activateWindow(); QTest::qWait(20);
    w.openPath(a); waitIdle(w);
    QVERIFY(!side(w)->isVisible());

    QTest::keyClick(&w, Qt::Key_Backslash, Qt::ControlModifier);
    QVERIFY(side(w)->isVisible());
    side(w)->setCurrentTab(SidePanel::Outline);
    QCOMPARE(side(w)->currentTab(), SidePanel::Outline);

    QTest::keyClick(&w, Qt::Key_Backslash, Qt::ControlModifier);
    QVERIFY(!side(w)->isVisible());

    QTest::keyClick(&w, Qt::Key_E, Qt::ControlModifier | Qt::ShiftModifier);
    QVERIFY(side(w)->isVisible());
    QCOMPARE(side(w)->currentTab(), SidePanel::Files);
  }

  void renamingToExistingNameShowsErrorAndLeavesTreeSessionAndDiskUnchanged() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    const QString b = dir + "/b.md";
    write(a, "# A\n\nbody\n");
    write(b, "keep");
    MainWindow w; start(w);
    w.openPath(a); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, a) && listed(w, b), 5000);
    editBody(w);
    const QString local = draft(w);

    panel(w)->beginRename(a);
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    QLineEdit* editor = panel(w)->renameEditor();
    editor->selectAll();
    QTest::keyClicks(editor, "b.md");
    QTest::keyClick(editor, Qt::Key_Return);
    QCoreApplication::processEvents();

    QCOMPARE(dialogs_.size(), 1);
    QCOMPARE(readAll(b), QStringLiteral("keep"));
    QVERIFY(QFileInfo::exists(a));
    QVERIFY(FileTreePanel::samePath(w.documentPath(), a));
    QCOMPARE(draft(w), local);
    const QStringList names = panel(w)->visibleChildNames(dir);
    QVERIFY(names.contains(QStringLiteral("a.md")));
    QVERIFY(names.contains(QStringLiteral("b.md")));
  }

  void floatingSidebarClosesWhenActivatingFileAndKeepsOpenOnRenameEscape() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    const QString b = dir + "/b.md";
    write(a, "# A\n");
    write(b, "# B\n");
    MainWindow w;
    w.resize(900, 600);
    w.show();
    w.activateWindow();
    QTest::qWait(20);
    w.openFolder(dir);
    w.openPath(a);
    waitIdle(w);

    if (!side(w)->isVisible()) emit w.findChild<Toolbar*>()->sidebarRequested();
    QVERIFY(side(w)->isVisible());
    QVERIFY(side(w)->isFloating());
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, a) && listed(w, b), 5000);

    panel(w)->beginRename(a);
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    QTest::keyClick(panel(w)->renameEditor(), Qt::Key_Escape);
    QVERIFY(!panel(w)->renameEditor());
    QVERIFY(side(w)->isVisible());

    click(w, b);
    waitIdle(w);
    QVERIFY(!side(w)->isVisible());
    QVERIFY(FileTreePanel::samePath(w.documentPath(), b));
  }

  void openingAFileOutsideTheFolderSwitchesToItsFolder() {
    const QString dir = folder();
    const QString other = folder();
    write(dir + "/a.md", "# A\n\nbody\n");
    write(dir + "/sub/b.md", "# B\n");
    write(other + "/x.md", "# X\n");
    MainWindow w; start(w);
    w.openFolder(dir);
    w.openPath(dir + "/a.md"); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, dir + "/a.md"), 5000);
    // Inside the open folder, even in a subfolder: the folder stays.
    w.openPath(dir + "/sub/b.md"); waitIdle(w);
    QVERIFY2(FileTreePanel::samePath(panel(w)->rootPath(), dir), qPrintable(panel(w)->rootPath()));
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, dir + "/sub/b.md"), 5000);
    // Ctrl+O, a drop or another window opens a file elsewhere: the panel follows it.
    w.openPath(other + "/x.md"); waitIdle(w);
    QVERIFY(FileTreePanel::samePath(w.documentPath(), other + "/x.md"));
    QVERIFY2(FileTreePanel::samePath(panel(w)->rootPath(), other), qPrintable(panel(w)->rootPath()));
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, other + "/x.md"), 5000);
    QVERIFY(panel(w)->isCurrentIndex(panel(w)->indexForPath(other + "/x.md")));
    // The same while the sidebar is closed.
    w.toggleSidebar();
    QVERIFY(!side(w)->isVisible());
    w.openPath(dir + "/a.md"); waitIdle(w);
    QVERIFY2(FileTreePanel::samePath(panel(w)->rootPath(), dir), qPrintable(panel(w)->rootPath()));
  }

  void abandonedNewFilesAreRemovedAndNamedOrWrittenOnesKept() {
    const QString dir = folder();
    const QString a = dir + "/a.md";
    write(a, "# A\n\nbody\n");
    MainWindow w; start(w);
    w.openPath(a); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, a), 5000);
    const auto untitled = [dir] { return QDir(dir).entryList({QStringLiteral("未命名*.md")}, QDir::Files); };

    // The switch is confirmed before anything is created.
    editBody(w);
    answer_ = QStringLiteral("继续编辑");
    emit panel(w)->newFileRequested(dir);
    waitIdle(w);
    QCOMPARE(dialogs_.size(), 1);
    QCOMPARE(untitled(), QStringList());
    QVERIFY(FileTreePanel::samePath(w.documentPath(), a));

    // Created, opened and left empty: switching away removes it again.
    answer_ = QStringLiteral("放弃更改");
    emit panel(w)->newFileRequested(dir);
    waitIdle(w);
    const QString first = dir + QStringLiteral("/未命名.md");
    QVERIFY2(FileTreePanel::samePath(w.documentPath(), first), qPrintable(w.documentPath()));
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    QTest::keyClick(panel(w)->renameEditor(), Qt::Key_Escape);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, a), 5000);
    click(w, a); waitIdle(w);
    QVERIFY(FileTreePanel::samePath(w.documentPath(), a));
    QCOMPARE(untitled(), QStringList());

    // Content in it, even written from outside, is never removed.
    emit panel(w)->newFileRequested(dir);
    waitIdle(w);
    QVERIFY(FileTreePanel::samePath(w.documentPath(), first));
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    QTest::keyClick(panel(w)->renameEditor(), Qt::Key_Escape);
    write(first, "external");
    click(w, a); waitIdle(w);
    QCOMPARE(readAll(first), QStringLiteral("external"));

    // Named in the tree: the user's file, kept even while empty.
    emit panel(w)->newFileRequested(dir);
    waitIdle(w);
    const QString second = dir + QStringLiteral("/未命名 2.md");
    QVERIFY2(FileTreePanel::samePath(w.documentPath(), second), qPrintable(w.documentPath()));
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    QLineEdit* editor = panel(w)->renameEditor();
    editor->selectAll();
    QTest::keyClicks(editor, "named.md");
    QTest::keyClick(editor, Qt::Key_Return);
    QTRY_VERIFY_WITH_TIMEOUT(QFileInfo::exists(dir + "/named.md"), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, a), 5000);
    click(w, a); waitIdle(w);
    QVERIFY(QFileInfo::exists(dir + "/named.md"));

    // Closing the window with an untouched new file removes it as well.
    emit panel(w)->newFileRequested(dir);
    waitIdle(w);
    QVERIFY(FileTreePanel::samePath(w.documentPath(), second));
    QVERIFY(w.close());
    QVERIFY(!QFileInfo::exists(second));
    QVERIFY(QFileInfo::exists(first));
    QVERIFY(QFileInfo::exists(dir + "/named.md"));
  }

  void treeRenamesWaitForBusyWorkAndReportErrorsAfterIt() {
    const QString dir = folder();
    const QString a = dir + "/a.md", b = dir + "/b.md", c = dir + "/c.md", d = dir + "/d.md";
    write(a, "# A\n");
    write(b, "# B\n");
    write(c, "# C\n");
    write(d, "# D\n");
    MainWindow w; start(w);
    w.openPath(a); waitIdle(w);
    w.openPath(c);
    QVERIFY(w.isAsyncBusy());
    // Typed while an open is still running: kept and retried, not dropped as busy.
    emit panel(w)->renameRequested(b, QStringLiteral("b2.md"));
    emit panel(w)->renameRequested(d, QStringLiteral("c.md"));
    QVERIFY(QFileInfo::exists(b));
    QCOMPARE(dialogs_, QStringList());
    waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(QFileInfo::exists(dir + "/b2.md"), 5000);
    QVERIFY(!QFileInfo::exists(b));
    // The clash is reported once the open has finished, not swallowed.
    QTRY_COMPARE_WITH_TIMEOUT(dialogs_.size(), 1, 5000);
    QVERIFY(QFileInfo::exists(d));
    QCOMPARE(readAll(c), QStringLiteral("# C\n"));
    QVERIFY(FileTreePanel::samePath(w.documentPath(), c));
  }

  void rememberedSidebarOpensOnlyWhereItDocks() {
    QTemporaryDir settingsDir;
    QVERIFY(settingsDir.isValid());
    // Never the user's settings: an INI file private to this test.
    const QSettings::Format format = QSettings::defaultFormat();
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsDir.path());
    const auto restore = qScopeGuard([format] { QSettings::setDefaultFormat(format); });
    {
      QSettings settings;
      settings.clear();
      settings.setValue(QStringLiteral("sidebar/visible"), true);
      settings.sync();
    }
    {
      // Decided after show: a window that ends up wide gets its sidebar back.
      MainWindow w;
      w.restoreWorkspace();
      w.resize(1200, 700);
      w.show();
      QTRY_VERIFY(side(w)->isVisible());
      QVERIFY(!side(w)->isFloating());
      QVERIFY(named(w.findChild<Toolbar*>(), QStringLiteral("侧边栏"))->isChecked());
    }
    {
      // Too narrow to dock: it stays closed instead of covering the document.
      MainWindow w;
      w.restoreWorkspace();
      w.resize(900, 700);
      w.show();
      QTest::qWait(50);
      QVERIFY(!side(w)->isVisible());
      QVERIFY(!named(w.findChild<Toolbar*>(), QStringLiteral("侧边栏"))->isChecked());
    }
  }

  void portableMarkerKeepsSettingsBesideTheProgram() {
    const auto reset = qScopeGuard([] { app_settings::configure(QString()); });
    const QString stick = folder();
    const QString program = QDir(stick).filePath(QStringLiteral("Vellora"));
    QVERIFY(QDir().mkpath(program));
    const QString ini = QDir(program).filePath(QStringLiteral("Vellora.ini"));

    // Without the marker the copy keeps the per-user store and writes nothing here.
    app_settings::configure(program);
    QVERIFY(!app_settings::isPortable());
    QVERIFY(!QFileInfo::exists(ini));

    write(QDir(program).filePath(QStringLiteral("portable.txt")), QByteArray());
    app_settings::configure(program);
    QVERIFY(app_settings::isPortable());
    QVERIFY(FileTreePanel::samePath(app_settings::iniPath(), ini));

    const QString notes = QDir(program).filePath(QStringLiteral("笔记"));
    write(QDir(notes).filePath(QStringLiteral("a.md")), "# a\n");
    {
      MainWindow w;
      w.restoreWorkspace();
      w.openFolder(notes);
    }
    {
      // Stored relative to the program, and as written for a program that moves.
      QSettings stored(ini, QSettings::IniFormat);
      QCOMPARE(stored.value(QStringLiteral("sidebar/rootRelative")).toString(), QStringLiteral("笔记"));
      QVERIFY(FileTreePanel::samePath(stored.value(QStringLiteral("sidebar/root")).toString(), notes));
      QVERIFY(stored.value(QStringLiteral("sidebar/visible")).toBool());
    }

    // The whole folder moves, as a stick does when it gets another drive letter.
    const QString moved = QDir(stick).filePath(QStringLiteral("Moved"));
    QVERIFY(QDir().rename(program, moved));
    app_settings::configure(moved);
    QVERIFY(app_settings::isPortable());
    MainWindow w;
    w.restoreWorkspace();
    QVERIFY(FileTreePanel::samePath(panel(w)->rootPath(), QDir(moved).filePath(QStringLiteral("笔记"))));
  }

  void portableSettingsFindTheFolderAfterTheProgramMovesOnItsDrive() {
    const auto reset = qScopeGuard([] { app_settings::configure(QString()); });
    const QString disk = folder();
    const QString program = QDir(disk).filePath(QStringLiteral("Vellora"));
    const QString notes = QDir(disk).filePath(QStringLiteral("Notes"));
    QVERIFY(QDir().mkpath(program));
    write(QDir(program).filePath(QStringLiteral("portable.txt")), QByteArray());
    write(QDir(notes).filePath(QStringLiteral("a.md")), "# a\n");
    app_settings::configure(program);
    QVERIFY(app_settings::isPortable());
    {
      MainWindow w;
      w.restoreWorkspace();
      w.openFolder(notes);
    }
    {
      QSettings stored(QDir(program).filePath(QStringLiteral("Vellora.ini")), QSettings::IniFormat);
      QCOMPARE(stored.value(QStringLiteral("sidebar/rootRelative")).toString(), QStringLiteral("../Notes"));
    }
    // Deeper on the same drive: "../Notes" now misses, the folder as written does not.
    const QString apps = QDir(disk).filePath(QStringLiteral("apps"));
    QVERIFY(QDir().mkpath(apps));
    const QString moved = QDir(apps).filePath(QStringLiteral("Vellora"));
    QVERIFY(QDir().rename(program, moved));
    app_settings::configure(moved);
    QVERIFY(app_settings::isPortable());
    MainWindow w;
    w.restoreWorkspace();
    QVERIFY2(FileTreePanel::samePath(panel(w)->rootPath(), notes), qPrintable(panel(w)->rootPath()));
  }

  void portableMarkerFallsBackWhenSettingsCannotBeSaved() {
    const auto reset = qScopeGuard([] { app_settings::configure(QString()); });
    {
      const QString program = folder();
      write(QDir(program).filePath(QStringLiteral("portable.txt")), QByteArray());
      // Something that is not a writable file already holds the name.
      QVERIFY(QDir(program).mkdir(QStringLiteral("Vellora.ini")));
      app_settings::configure(program);
      QVERIFY(!app_settings::isPortable());
      QVERIFY(app_settings::iniPath().isEmpty());
    }
    {
      const QString program = folder();
      write(QDir(program).filePath(QStringLiteral("portable.txt")), QByteArray());
      const QString ini = QDir(program).filePath(QStringLiteral("Vellora.ini"));
      write(ini, "[sidebar]\nvisible=true\n");
      QVERIFY(QFile::setPermissions(ini, QFileDevice::ReadOwner | QFileDevice::ReadUser));
      const auto writable = qScopeGuard([ini] {
        QFile::setPermissions(ini, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ReadUser | QFileDevice::WriteUser);
      });
      app_settings::configure(program);
      QVERIFY(!app_settings::isPortable());
      QCOMPARE(readAll(ini), QStringLiteral("[sidebar]\nvisible=true\n"));
    }
  }

  void portableSettingsKeepOtherDrivesAndSharesAbsolute() {
    const auto reset = qScopeGuard([] { app_settings::configure(QString()); });
    const QString program = folder();
    // Outside portable mode every path is stored exactly as written.
    QCOMPARE(app_settings::storePath(program), program);
    write(QDir(program).filePath(QStringLiteral("portable.txt")), QByteArray());
    app_settings::configure(program);
    QVERIFY(app_settings::isPortable());
#ifdef Q_OS_WIN
    // Drive letters and UNC shares exist only on Windows.
    const QChar drive = program.at(0).toUpper();
    const QString other = QStringLiteral("%1:/notes").arg(drive == QLatin1Char('Z') ? QLatin1Char('Y') : QLatin1Char('Z'));
    QCOMPARE(app_settings::storePath(other), other);
    QCOMPARE(app_settings::resolvePath(other), other);
    const QString share = QStringLiteral("//server/share/notes");
    QCOMPARE(app_settings::storePath(share), share);
    QCOMPARE(app_settings::resolvePath(share), share);
#endif
    QCOMPARE(app_settings::storePath(program), QStringLiteral("."));
    QVERIFY(FileTreePanel::samePath(app_settings::resolvePath(QStringLiteral(".")), program));
    QVERIFY(FileTreePanel::samePath(app_settings::resolvePath(app_settings::storePath(QDir(program).filePath(QStringLiteral("../sibling")))),
                                    QDir::cleanPath(QDir(program).filePath(QStringLiteral("../sibling")))));
  }

  void openRowIsOneFullWidthStripWithoutFocusRing() {
    const QString dir = folder();
    const QString deep = dir + "/sub/deep.md";
    write(dir + "/a.md", "# A\n");
    write(deep, "# Deep\n\nbody\n");
    MainWindow w; start(w);
    // Open the parent first: opening the file alone would make sub/ the root
    // and list deep.md at the top level, with no indentation to check.
    w.openFolder(dir);
    w.openPath(deep); waitIdle(w);
    QVERIFY(FileTreePanel::samePath(panel(w)->rootPath(), dir));
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, deep), 5000);
    QTreeView* tree = panel(w)->tree();
    const QModelIndex index = panel(w)->indexForPath(deep);
    QVERIFY(panel(w)->isCurrentIndex(index));
    // Keyboard focus on the open row: the case that used to draw a ring.
    tree->setFocus(Qt::OtherFocusReason);
    tree->setCurrentIndex(index);
    QTRY_VERIFY(tree->hasFocus());
    QTest::qWait(30);
    const QRect item = tree->visualRect(index);
    // Nested one level below the root: the item starts after two indentation steps.
    QVERIFY2(item.left() >= 20, qPrintable(QString::number(item.left())));
    const QImage image = tree->viewport()->grab().toImage();
    const qreal ratio = image.devicePixelRatio();
    const auto at = [&](int x, int y) { return image.pixelColor(qRound(x * ratio), qRound(y * ratio)); };
    const auto sameColour = [](const QColor& a, const QColor& b) {
      return qAbs(a.red() - b.red()) <= 4 && qAbs(a.green() - b.green()) <= 4 && qAbs(a.blue() - b.blue()) <= 4;
    };
    const int y = item.top() + 4;
    const QColor strip = theme::selectionBg();
    for (const int x : {4, item.left() / 2, item.left() - 2, item.left() + 2, tree->viewport()->width() - 12}) {
      QVERIFY2(sameColour(at(x, y), strip), qPrintable(QStringLiteral("x=%1 %2").arg(x).arg(at(x, y).name())));
    }
    // No focus ring anywhere on the row.
    const QColor ring = theme::focusRing();
    for (int yy = item.top(); yy <= item.bottom(); ++yy) {
      for (int x = 0; x < tree->viewport()->width(); ++x) {
        QVERIFY2(!sameColour(at(x, yy), ring), qPrintable(QStringLiteral("ring at %1,%2").arg(x).arg(yy)));
      }
    }
    // Another row under keyboard focus shows only the light tint, never the warm strip.
    const QModelIndex other = panel(w)->indexForPath(dir + "/a.md");
    QVERIFY(other.isValid());
    tree->setCurrentIndex(other);
    QTest::qWait(30);
    const QImage after = tree->viewport()->grab().toImage();
    const QRect otherRect = tree->visualRect(other);
    const QColor tint = after.pixelColor(qRound(4 * ratio), qRound((otherRect.top() + 4) * ratio));
    QVERIFY2(!sameColour(tint, strip), qPrintable(tint.name()));
    QVERIFY(sameColour(after.pixelColor(qRound(4 * ratio), qRound(y * ratio)), strip));
  }

  void renameFieldCancelsWhenItsRowIsHiddenAndSurvivesScrolling() {
    const QString dir = folder();
    const QString nested = dir + "/sub/nested.md";
    write(nested, "# N\n");
    for (int i = 0; i < 40; ++i) write(dir + QStringLiteral("/f%1.md").arg(i, 2, 10, QLatin1Char('0')), "# F\n");
    MainWindow w; start(w);
    w.openFolder(dir);
    QTreeView* tree = panel(w)->tree();

    // Collapsing the folder hides the row: the field goes and nothing is renamed.
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->indexForPath(dir + "/sub").isValid(), 5000);
    tree->expand(panel(w)->indexForPath(dir + "/sub"));
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, nested), 5000);
    panel(w)->beginRename(nested);
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    QLineEdit* editor = panel(w)->renameEditor();
    editor->selectAll();
    QTest::keyClicks(editor, "renamed.md");
    tree->collapse(panel(w)->indexForPath(dir + "/sub"));
    QTRY_VERIFY(!panel(w)->renameEditor());
    QTest::qWait(50);
    QCOMPARE(dialogs_, QStringList());
    QVERIFY(QFileInfo::exists(nested));
    QVERIFY(!QFileInfo::exists(dir + "/sub/renamed.md"));
    // Focus returns to the list, not to nowhere (only checkable in an active window).
    if (w.isActiveWindow()) QVERIFY(tree->hasFocus());

    // Scrolling the row away keeps the field and what was typed.
    const QString first = dir + "/f00.md";
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, first), 5000);
    tree->scrollToTop();
    panel(w)->beginRename(first);
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->renameEditor(), 5000);
    editor = panel(w)->renameEditor();
    editor->selectAll();
    QTest::keyClicks(editor, "kept.md");
    tree->scrollToBottom();
    QTest::qWait(50);
    QVERIFY(!tree->viewport()->rect().intersects(tree->visualRect(panel(w)->indexForPath(first))));
    QCOMPARE(panel(w)->renameEditor(), editor);
    QCOMPARE(editor->text(), QStringLiteral("kept.md"));
    QVERIFY(QFileInfo::exists(first));
    tree->scrollToTop();
    QTest::qWait(50);
    QVERIFY(editor->isVisible());
    QTest::keyClick(editor, Qt::Key_Return);
    QVERIFY(!panel(w)->renameEditor());
    QCOMPARE(dialogs_, QStringList());
    QVERIFY(QFileInfo::exists(dir + "/kept.md"));
    QVERIFY(!QFileInfo::exists(first));
  }

  void deletingAsksEveryTimeAndMovesTheFileToTheRecycleBin() {
    const QString dir = folder();
    const QString a = dir + "/a.md", b = dir + "/b.md";
    write(a, "# A\n\nbody\n");
    write(b, "# B\n");
    MainWindow w; start(w);
    w.openPath(a); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, b), 5000);
    QTreeView* tree = panel(w)->tree();
    tree->setCurrentIndex(panel(w)->indexForPath(b));

    // Cancelled: nothing reaches the shell.
    QTest::keyClick(tree, Qt::Key_Delete);
    QTRY_COMPARE(dialogs_.size(), 1);
    QVERIFY2(dialogs_.first().contains(QStringLiteral("删除")), qPrintable(dialogs_.first()));
    QVERIFY(dialogs_.first().contains(QStringLiteral("取消")));
    QTest::qWait(50);
    QVERIFY(deletes_.isEmpty());
    QVERIFY(QFileInfo::exists(b));

    answer_ = QStringLiteral("删除");
    QTest::keyClick(tree, Qt::Key_Delete);
    QTRY_VERIFY(!QFileInfo::exists(b));
    QCOMPARE(dialogs_.size(), 2);
    QCOMPARE(deletes_.size(), 1);
    QVERIFY2(FileTreePanel::samePath(deletes_.first().first, b), qPrintable(deletes_.first().first));
    QVERIFY(!deletes_.first().second);
    // Another file was deleted: the open document stays as it was.
    QVERIFY(FileTreePanel::samePath(w.documentPath(), a));
    QVERIFY(side(w)->isVisible());
    QTRY_VERIFY(!panel(w)->indexForPath(b).isValid());
  }

  void deletingTheOpenDocumentWarnsAboutUnsavedChangesAndCloses() {
    const QString dir = folder();
    const QString a = dir + "/a.md", b = dir + "/b.md";
    write(a, "# A\n\nbody\n");
    write(b, "# B\n");
    MainWindow w; start(w);
    w.openPath(a); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, a), 5000);
    editBody(w);
    QTreeView* tree = panel(w)->tree();
    tree->setCurrentIndex(panel(w)->indexForPath(a));
    answer_ = QStringLiteral("放弃更改并删除");
    QTest::keyClick(tree, Qt::Key_Delete);
    QTRY_VERIFY(!QFileInfo::exists(a));
    QCOMPARE(dialogs_.size(), 1);
    QVERIFY2(dialogs_.first().contains(QStringLiteral("放弃更改并删除")), qPrintable(dialogs_.first()));
    QVERIFY(w.documentPath().isEmpty());
    QVERIFY(!bridge::sessionMatches(a).value("matches").toBool());
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, b), 5000);
    // The discarded draft went with the file: closing asks nothing, writes nothing.
    QVERIFY(w.close());
    QCOMPARE(dialogs_.size(), 1);
    QVERIFY(!QFileInfo::exists(a));
  }

  void unrecyclableEntriesAskAgainBeforeDeletingPermanently() {
    const QString dir = folder();
    const QString notes = dir + "/notes";
    write(notes + "/x.md", "# X\n");
    write(notes + "/picture.png", "png");
    MainWindow w; start(w);
    w.openFolder(dir);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, notes), 5000);
    QTreeView* tree = panel(w)->tree();
    notRecyclable_ = true;

    // Confirmed once, then the permanent deletion is declined: all of it stays.
    tree->setCurrentIndex(panel(w)->indexForPath(notes));
    answers_ = {QStringLiteral("删除")};
    QTest::keyClick(tree, Qt::Key_Delete);
    QTRY_COMPARE(dialogs_.size(), 2);
    QVERIFY2(!dialogs_.at(0).contains(QStringLiteral("永久删除")), qPrintable(dialogs_.at(0)));
    QVERIFY2(dialogs_.at(1).contains(QStringLiteral("永久删除")), qPrintable(dialogs_.at(1)));
    QTest::qWait(50);
    QCOMPARE(deletes_.size(), 1);
    QVERIFY(!deletes_.at(0).second);
    QVERIFY(QFileInfo::exists(notes + "/x.md"));
    QVERIFY(QFileInfo::exists(notes + "/picture.png"));

    QTRY_VERIFY_WITH_TIMEOUT(listed(w, notes), 5000);
    tree->setCurrentIndex(panel(w)->indexForPath(notes));
    answers_ = {QStringLiteral("删除"), QStringLiteral("永久删除")};
    QTest::keyClick(tree, Qt::Key_Delete);
    QTRY_VERIFY(!QFileInfo::exists(notes));
    QCOMPARE(dialogs_.size(), 4);
    QCOMPARE(deletes_.size(), 3);
    QVERIFY(!deletes_.at(1).second);
    QVERIFY(deletes_.at(2).second);
    // The panel watches its folder again after a folder was deleted.
    write(dir + "/after.md", "# After\n");
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, dir + "/after.md"), 5000);
  }

  void deletingAFolderClosesTheDocumentInsideIt() {
    const QString dir = folder();
    const QString inner = dir + "/sub/inner.md", keep = dir + "/keep.md";
    write(inner, "# Inner\n");
    write(keep, "# Keep\n");
    MainWindow w; start(w);
    w.openFolder(dir);
    w.openPath(inner); waitIdle(w);
    QVERIFY(FileTreePanel::samePath(w.documentPath(), inner));
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, dir + "/sub"), 5000);
    QTreeView* tree = panel(w)->tree();
    tree->setCurrentIndex(panel(w)->indexForPath(dir + "/sub"));
    answer_ = QStringLiteral("删除");
    QTest::keyClick(tree, Qt::Key_Delete);
    QTRY_VERIFY(!QFileInfo::exists(dir + "/sub"));
    QCOMPARE(dialogs_.size(), 1);
    QCOMPARE(deletes_.size(), 1);
    QVERIFY(w.documentPath().isEmpty());
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, keep), 5000);
    QVERIFY(QFileInfo::exists(keep));
  }

  void draggingAFileOntoAFolderMovesItAndKeepsTheDraft() {
    const QString dir = folder();
    const QString a = dir + "/a.md", b = dir + "/b.md", sub = dir + "/sub";
    write(a, "# A\n\nbody\n");
    write(b, "# B\n");
    write(sub + "/x.md", "# X\n");
    MainWindow w; start(w);
    w.openFolder(dir);
    w.openPath(a); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, sub), 5000);
    editBody(w);
    const QString local = draft(w);

    QVERIFY(dropOn(w, a, sub));
    QTRY_VERIFY(QFileInfo::exists(sub + "/a.md"));
    QVERIFY(!QFileInfo::exists(a));
    QCOMPARE(dialogs_, QStringList());
    // The open document followed without reopening: same draft, new session path.
    QVERIFY2(FileTreePanel::samePath(w.documentPath(), sub + "/a.md"), qPrintable(w.documentPath()));
    QCOMPARE(draft(w), local);
    QVERIFY(bridge::sessionMatches(w.documentPath()).value("matches").toBool());

    // Dropped on a file row: it goes into that file's folder.
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, sub + "/x.md"), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, b), 5000);
    QVERIFY(dropOn(w, b, sub + "/x.md"));
    QTRY_VERIFY(QFileInfo::exists(sub + "/b.md"));
    QCOMPARE(dialogs_, QStringList());
    QVERIFY(FileTreePanel::samePath(w.documentPath(), sub + "/a.md"));
  }

  void dropsIntoTheSameFolderOrBelowThemselvesAreRefused() {
    const QString dir = folder();
    const QString notes = dir + "/notes", top = dir + "/top.md";
    write(notes + "/inner/i.md", "# I\n");
    write(notes + "/n.md", "# N\n");
    write(top, "# Top\n");
    MainWindow w; start(w);
    w.openFolder(dir);
    QTreeView* tree = panel(w)->tree();
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, notes), 5000);
    tree->expand(panel(w)->indexForPath(notes));
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, notes + "/inner"), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, notes + "/n.md"), 5000);
    QVERIFY(!dropOn(w, notes, notes));
    QVERIFY(!dropOn(w, notes, notes + "/inner"));
    QVERIFY(!dropOn(w, notes + "/n.md", notes));
    QVERIFY(!dropOn(w, top, QString()));
    // Only the panel's own drag moves anything.
    QVERIFY(!dropOn(w, top, notes, QStringLiteral("text/plain")));
    QTest::qWait(50);
    QCOMPARE(dialogs_, QStringList());
    QVERIFY(QFileInfo::exists(notes + "/inner/i.md"));
    QVERIFY(QFileInfo::exists(notes + "/n.md"));
    QVERIFY(QFileInfo::exists(top));

    // Below the last row is the open folder itself.
    QVERIFY(dropOn(w, notes + "/n.md", QString()));
    QTRY_VERIFY(QFileInfo::exists(dir + "/n.md"));
    QVERIFY(!QFileInfo::exists(notes + "/n.md"));
  }

  void relativeLinksAskBeforeAFileMoves() {
    const QString dir = folder();
    const QString b = dir + "/b.md", sub = dir + "/sub";
    write(b, "# B\n\n![p](img/p.png) [o](other.md) [web](https://example.com)\n");
    QVERIFY(QDir().mkpath(sub));
    MainWindow w; start(w);
    w.openFolder(dir);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, b), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, sub), 5000);
    const QJsonObject info = bridge::inspectMove(b, sub, nullptr);
    QCOMPARE(info.value("relativeReferences").toInt(), 2);
    QCOMPARE(info.value("examples").toArray().size(), 2);

    // Esc on the warning: nothing moves.
    QVERIFY(dropOn(w, b, sub));
    QTRY_COMPARE(dialogs_.size(), 1);
    QVERIFY2(dialogs_.first().contains(QStringLiteral("仍然移动")), qPrintable(dialogs_.first()));
    QVERIFY(dialogs_.first().contains(QStringLiteral("取消")));
    QTest::qWait(50);
    QVERIFY(QFileInfo::exists(b));

    answer_ = QStringLiteral("仍然移动");
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, b), 5000);
    QVERIFY(dropOn(w, b, sub));
    QTRY_VERIFY(QFileInfo::exists(sub + "/b.md"));
    QCOMPARE(dialogs_.size(), 2);
    QVERIFY(!QFileInfo::exists(b));
  }

  void movingAFolderTakesTheOpenDocumentAlongWithoutAsking() {
    const QString dir = folder();
    const QString drafts = dir + "/drafts", archive = dir + "/archive";
    const QString note = drafts + "/deep/note.md";
    write(note, "# Note\n\n![p](p.png)\n");
    QVERIFY(QDir().mkpath(archive));
    MainWindow w; start(w);
    w.openFolder(dir);
    w.openPath(note); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, drafts), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, archive), 5000);
    QVERIFY(dropOn(w, drafts, archive));
    const QString moved = archive + "/drafts/deep/note.md";
    QTRY_VERIFY(QFileInfo::exists(moved));
    QCOMPARE(dialogs_, QStringList());
    QVERIFY(!QFileInfo::exists(drafts));
    QVERIFY2(FileTreePanel::samePath(w.documentPath(), moved), qPrintable(w.documentPath()));
    QVERIFY(bridge::sessionMatches(w.documentPath()).value("matches").toBool());
    // The panel watches its folder again after a folder moved.
    write(dir + "/after.md", "# After\n");
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, dir + "/after.md"), 5000);
  }

  void movingOntoAnExistingNameReportsItAndChangesNothing() {
    const QString dir = folder();
    const QString a = dir + "/a.md", sub = dir + "/sub";
    write(a, "mine");
    write(sub + "/a.md", "keep");
    MainWindow w; start(w);
    w.openFolder(dir);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, a), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, sub), 5000);
    QVERIFY(dropOn(w, a, sub));
    QTRY_COMPARE(dialogs_.size(), 1);
    QVERIFY2(dialogs_.first().contains(QStringLiteral("知道了")), qPrintable(dialogs_.first()));
    QCOMPARE(readAll(a), QStringLiteral("mine"));
    QCOMPARE(readAll(sub + "/a.md"), QStringLiteral("keep"));
  }
};
QTEST_MAIN(FileTreeRegressions)
#include "file_tree_regressions.moc"
