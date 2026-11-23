#include <QtWidgets>
#include <QtTest>
#include <QScopeGuard>
#include <QSettings>
#include "bridge.h"
#include "chrome.h"
#include "document_view.h"
#include "file_tree_panel.h"
#include "main_window.h"
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

 private slots:
  void initTestCase() {
    QVERIFY(files_.isValid());
    QApplication::setQuitOnLastWindowClosed(false);
    // Answers each modal once: the button named by answer_, otherwise Esc.
    connect(&dialogTimer_, &QTimer::timeout, this, [this] {
      for (auto* widget : QApplication::allWidgets()) {
        auto* dialog = qobject_cast<ModalDialog*>(widget);
        if (!dialog || !dialog->isVisible() || dialog->property("answered").toBool()) continue;
        dialog->setProperty("answered", true);
        QStringList labels;
        QPushButton* target = nullptr;
        for (auto* button : dialog->findChildren<QPushButton*>()) {
          labels << button->text();
          if (button->text() == answer_) target = button;
        }
        dialogs_ << labels.join(QLatin1Char('|'));
        if (target) target->click();
        else QTest::keyClick(dialog, Qt::Key_Escape);
      }
    });
    dialogTimer_.start(10);
  }
  void init() { dialogs_.clear(); answer_.clear(); }

  void pathsFromTheCoreCompareEqual() {
    QVERIFY(FileTreePanel::samePath(QStringLiteral("\\\\?\\C:\\Notes\\a.md"), QStringLiteral("C:/Notes/a.md")));
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

  void openingAFileOutsideTheFolderKeepsTheFolder() {
    const QString dir = folder();
    const QString other = folder();
    write(dir + "/a.md", "# A\n\nbody\n");
    write(other + "/x.md", "# X\n");
    MainWindow w; start(w);
    w.openFolder(dir);
    w.openPath(dir + "/a.md"); waitIdle(w);
    QTRY_VERIFY_WITH_TIMEOUT(listed(w, dir + "/a.md"), 5000);
    // Ctrl+O, a drop or another window opens a file elsewhere: the folder stays.
    w.openPath(other + "/x.md"); waitIdle(w);
    QVERIFY(FileTreePanel::samePath(w.documentPath(), other + "/x.md"));
    QVERIFY2(FileTreePanel::samePath(panel(w)->rootPath(), dir), qPrintable(panel(w)->rootPath()));
    QVERIFY(!panel(w)->isCurrentIndex(panel(w)->indexForPath(dir + "/a.md")));
    // The same while the sidebar is closed.
    w.toggleSidebar();
    QVERIFY(!side(w)->isVisible());
    w.openPath(dir + "/a.md"); waitIdle(w);
    w.openPath(other + "/x.md"); waitIdle(w);
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
};
QTEST_MAIN(FileTreeRegressions)
#include "file_tree_regressions.moc"
