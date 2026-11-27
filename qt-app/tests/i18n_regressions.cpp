#include <QtTest>
#include <QtWidgets>

#include "bridge.h"
#include "chrome.h"
#include "document_view.h"
#include "file_tree_panel.h"
#include "main_window.h"
#include "theme.h"
#include "ui_language.h"
#include "ui_text.h"

using ui_language::Language;

// The UI language follows the system: Chinese UI languages keep the Chinese
// interface, every other language gets English. English labels must fit the
// same layout: no elided, clipped or stacked controls where Chinese fits.
// VELLORA_I18N_SHOTS=<folder> also saves a screenshot of every checked state.
class I18nRegressions : public QObject {
  Q_OBJECT
  QTemporaryDir files_;
  QString folder_;
  QString guide_;
  QString other_;
  QTimer dialogTimer_;
  // Labels of the dialog button to press, either language; otherwise Esc.
  QStringList answers_;
  // What each dialog looked like: problems found, and its buttons.
  QStringList dialogProblems_;
  QStringList dialogButtons_;
  QString shotPrefix_;
  int shotCount_ = 0;
  // Screenshot names of the dialogs labelsFitAtDefaultAndNarrowSizes opens, in order.
  const QStringList dialogShots_{
      QStringLiteral("dialog-replace-all"), QStringLiteral("dialog-delete"),
      QStringLiteral("dialog-unsaved-quit"), QStringLiteral("dialog-delete-unsaved")};

  static void write(const QString& path, const QByteArray& bytes) {
    if (!QDir().mkpath(QFileInfo(path).absolutePath())) qFatal("fixture folder");
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size())
      qFatal("fixture write");
  }
  static void waitIdle(MainWindow& w) {
    QElapsedTimer timer;
    timer.start();
    while (w.isAsyncBusy() && timer.elapsed() < 10000) {
      QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
    }
    QTest::qWait(50);
  }
  static SidePanel* side(MainWindow& w) { return w.findChild<SidePanel*>(); }
  static FileTreePanel* panel(MainWindow& w) { return w.findChild<FileTreePanel*>(); }
  static QToolButton* named(QWidget* parent, const QString& name) {
    for (auto* button : parent->findChildren<QToolButton*>()) {
      if (button->accessibleName() == name) return button;
    }
    return nullptr;
  }

  void shot(QWidget* widget, const QString& name, QWidget* overlay = nullptr) {
    const QString folder = qEnvironmentVariable("VELLORA_I18N_SHOTS");
    if (folder.isEmpty()) return;
    QDir().mkpath(folder);
    QPixmap image = widget->grab();
    if (overlay) {
      QPainter painter(&image);
      painter.drawPixmap(widget->mapFromGlobal(overlay->mapToGlobal(QPoint(0, 0))),
                         overlay->grab());
    }
    image.save(QDir(folder).filePath(QStringLiteral("%1-%2.png").arg(shotPrefix_, name)));
  }

  // Every visible control whose text does not fit: buttons narrower than their
  // label needs, single-line labels wider than their box or elided, wrapped
  // labels taller than their box, placeholders wider than their field, and the
  // custom-painted view switch.
  static QStringList clipped(QWidget* root) {
    QStringList problems;
    auto describe = [](QWidget* widget, const QString& text) {
      return QStringLiteral("%1 \"%2\" (%3 px)")
          .arg(QString::fromLatin1(widget->metaObject()->className()), text)
          .arg(widget->width());
    };
    for (QWidget* widget : root->findChildren<QWidget*>()) {
      if (!widget->isVisible() || widget->width() <= 0) continue;
      if (qobject_cast<SegmentedControl*>(widget->parentWidget())) {
        auto* segment = qobject_cast<QAbstractButton*>(widget);
        if (!segment) continue;
        // Painted by SegmentedControl in 12 px; keep 4 px clear on each side.
        const int needed =
            QFontMetrics(theme::uiFont(12, QFont::Medium)).horizontalAdvance(segment->text()) + 8;
        if (needed > segment->width()) problems << describe(widget, segment->text());
        continue;
      }
      if (auto* button = qobject_cast<QAbstractButton*>(widget)) {
        if (button->text().isEmpty()) continue;
        if (button->sizeHint().width() <= button->width()) continue;
        // A fixed-size tool button (Open, Save) is narrower than its generous
        // size hint by design: its icon, 4 px gap and label must still fit with
        // at least 2 px on each side.
        auto* tool = qobject_cast<QToolButton*>(button);
        const bool fixed = button->minimumWidth() == button->maximumWidth();
        if (tool && fixed) {
          const int icon =
              tool->icon().isNull() || tool->toolButtonStyle() == Qt::ToolButtonTextOnly
                  ? 0
                  : tool->iconSize().width() + 4;
          // The last horizontal padding its style sheet sets.
          int padding = 0;
          static const QRegularExpression paddingRule(QStringLiteral("padding:\\s*0\\s+(\\d+)px"));
          for (auto match = paddingRule.globalMatch(tool->styleSheet()); match.hasNext();) {
            padding = match.next().captured(1).toInt();
          }
          if (icon + tool->fontMetrics().horizontalAdvance(tool->text()) + 2 * padding <=
              tool->width())
            continue;
        }
        problems << describe(widget, button->text());
      } else if (auto* label = qobject_cast<QLabel*>(widget)) {
        const QString text = label->text();
        if (text.isEmpty() || label->textFormat() == Qt::RichText) continue;
        if (text.contains(QChar(0x2026))) {
          problems << describe(widget, text) + QStringLiteral(" elided");
        } else if (label->wordWrap()) {
          if (label->heightForWidth(label->width()) > label->height() + 1) {
            problems << describe(widget, text) + QStringLiteral(" cut off");
          }
        } else if (label->fontMetrics().horizontalAdvance(text) > label->contentsRect().width()) {
          problems << describe(widget, text);
        }
      } else if (auto* edit = qobject_cast<QLineEdit*>(widget)) {
        const QString placeholder = edit->placeholderText();
        if (!placeholder.isEmpty() && edit->text().isEmpty() &&
            edit->fontMetrics().horizontalAdvance(placeholder) > edit->width() - 16) {
          problems << describe(widget, placeholder);
        }
      }
    }
    return problems;
  }

  void prepare(Language language) {
    QVERIFY(ui_language::apply(*qApp, language));
    shotPrefix_ = ui_language::tag(language);
  }

  // Opens the fixture document at `size`, with the sidebar shown when asked.
  void open(MainWindow& w, QSize size, bool sidebar) {
    w.resize(size);
    w.show();
    w.activateWindow();
    QVERIFY(QTest::qWaitForWindowExposed(&w));
    w.openPath(guide_);
    waitIdle(w);
    QCOMPARE(w.documentPath().isEmpty(), false);
    if (sidebar && !side(w)->isVisible()) w.toggleSidebar();
    QTest::qWait(300);
  }

  void editBody(MainWindow& w) {
    auto* view = w.findChild<DocumentView*>();
    QVERIFY(view->revealText(QStringLiteral("reader")));
    QTest::keyClick(view, Qt::Key_End);
    QTest::keyClicks(view, " more");
    QTest::qWait(50);
  }

 private slots:
  void initTestCase() {
    QVERIFY(files_.isValid());
    // The application's own font and style (main.cpp), so text is measured as shown.
    QApplication::setFont(theme::uiFont(14));
    QApplication::setStyle(QStringLiteral("Fusion"));
    QApplication::setPalette(theme::appPalette(QApplication::style()->standardPalette()));
    QApplication::setQuitOnLastWindowClosed(false);
    folder_ = files_.filePath(QStringLiteral("notes"));
    guide_ = folder_ + QStringLiteral("/guide.md");
    other_ = folder_ + QStringLiteral("/other.md");
    const QByteArray markdown =
        "# Vellora Guide\n\nVellora is a Markdown reader and editor.\n\n## Getting Started\n\n"
        "- Open a file\n- Edit it directly\n\n## Code\n\n```rust\nfn main() {}\n```\n";
    write(guide_, markdown);
    write(other_, markdown);
    write(folder_ + QStringLiteral("/drafts/idea.md"), "# Idea\n");
    // Checks each modal once, saves it, then presses the answer (or Esc).
    connect(&dialogTimer_, &QTimer::timeout, this, [this] {
      for (auto* widget : QApplication::allWidgets()) {
        auto* dialog = qobject_cast<ModalDialog*>(widget);
        if (!dialog || !dialog->isVisible() || dialog->property("checked").toBool()) continue;
        dialog->setProperty("checked", true);
        QTest::qWait(250);  // let the enter motion finish before measuring
        for (auto* layout : dialog->findChildren<QBoxLayout*>()) {
          int buttons = 0;
          for (int i = 0; i < layout->count(); ++i) {
            if (qobject_cast<QPushButton*>(layout->itemAt(i)->widget())) ++buttons;
          }
          const bool vertical = layout->direction() == QBoxLayout::TopToBottom ||
                                layout->direction() == QBoxLayout::BottomToTop;
          if (buttons >= 2 && vertical) {
            dialogProblems_
                << QStringLiteral("buttons stacked in dialog %1").arg(dialogButtons_.size() + 1);
          }
        }
        dialogProblems_ << clipped(dialog);
        QPushButton* target = nullptr;
        QStringList labels;
        for (auto* button : dialog->findChildren<QPushButton*>()) {
          if (!button->isVisible()) continue;
          labels << button->text();
          if (answers_.contains(button->text())) target = button;
        }
        dialogButtons_ << labels.join(QLatin1Char('|'));
        const int index = shotCount_++;
        shot(dialog->window(),
             dialogShots_.value(index, QStringLiteral("dialog-%1").arg(index + 1)));
        if (target)
          target->click();
        else
          QTest::keyClick(dialog, Qt::Key_Escape);
      }
    });
    dialogTimer_.start(20);
    // Never the real recycle bin.
    bridge::setDiskDeleterForTesting([](const QString&, bool) { return 0; });
  }
  void cleanupTestCase() {
    bridge::setDiskDeleterForTesting({});
    ui_language::apply(*qApp, Language::Chinese);
  }
  void init() {
    answers_.clear();
    dialogProblems_.clear();
    dialogButtons_.clear();
    shotCount_ = 0;
  }
  void cleanup() { ui_language::apply(*qApp, Language::Chinese); }

  void systemLanguageRule_data() {
    QTest::addColumn<QStringList>("languages");
    QTest::addColumn<QString>("override");
    QTest::addColumn<bool>("chinese");
    const QStringList chinese{"zh",      "zh-CN",       "zh-Hans-CN", "zh-TW",
                              "zh-Hant", "zh-Hant-TW",  "zh-HK",      "zh-Hant-HK",
                              "zh-SG",   "zh_TW.UTF-8", "ZH-cn"};
    for (const QString& tag : chinese)
      QTest::newRow(qPrintable(tag)) << QStringList{tag} << QString() << true;
    const QStringList other{"en-US", "en-GB", "en",    "ja-JP", "ja",
                            "de-DE", "fr",    "ko-KR", "C",     "zhx"};
    for (const QString& tag : other)
      QTest::newRow(qPrintable(tag)) << QStringList{tag} << QString() << false;
    QTest::newRow("no languages") << QStringList() << QString() << false;
    // Only the preferred (first) language decides.
    QTest::newRow("en first") << QStringList{"en-US", "zh-CN"} << QString() << false;
    QTest::newRow("zh first") << QStringList{"zh-TW", "en-US"} << QString() << true;
    QTest::newRow("override en") << QStringList{"zh-CN"} << QStringLiteral("en") << false;
    QTest::newRow("override EN-us") << QStringList{"zh-CN"} << QStringLiteral("EN-us") << false;
    QTest::newRow("override zh") << QStringList{"de-DE"} << QStringLiteral("zh") << true;
    QTest::newRow("override zh_TW") << QStringList{"en-US"} << QStringLiteral("zh_TW") << true;
    QTest::newRow("unknown override") << QStringList{"zh-CN"} << QStringLiteral("fr") << true;
    QTest::newRow("empty override") << QStringList{"en-US"} << QString() << false;
  }
  void systemLanguageRule() {
    QFETCH(QStringList, languages);
    QFETCH(QString, override);
    QFETCH(bool, chinese);
    QCOMPARE(ui_language::choose(languages, override) == Language::Chinese, chinese);
  }

  void chineseIsTheSourceText() {
    prepare(Language::Chinese);
    QCOMPARE(ui::tr("全部替换"), QStringLiteral("全部替换"));
    QCOMPARE(ui::tr("已替换 %n 处", 3), QStringLiteral("已替换 3 处"));
    QCOMPARE(ui::trTrash("无法移到回收站"), QStringLiteral("无法移到回收站"));
    QCOMPARE(
        bridge::createMarkdown(QStringLiteral("relative"), QString()).value("message").toString(),
        QStringLiteral("路径无效。"));
    MainWindow w;
    w.show();
    QVERIFY(named(&w, QStringLiteral("打开文件")));
    QCOMPARE(named(&w, QStringLiteral("打开文件"))->text(), QStringLiteral("打开"));
  }

  void englishTranslationAndCoreMessages() {
    prepare(Language::English);
    QCOMPARE(ui::tr("全部替换"), QStringLiteral("Replace All"));
    QCOMPARE(ui::tr("未保存更改"), QStringLiteral("Unsaved Changes"));
    QCOMPARE(ui::tr("继续编辑"), QStringLiteral("Keep Editing"));
    QCOMPARE(ui::tr("知道了"), QStringLiteral("OK"));
    QCOMPARE(ui::tr("撤销"), QStringLiteral("Undo"));
    QCOMPARE(ui::tr("已替换 %n 处", 1), QStringLiteral("Replaced 1 match"));
    QCOMPARE(ui::tr("已替换 %n 处", 3), QStringLiteral("Replaced 3 matches"));
    QCOMPARE(ui::tr("、"), QStringLiteral(", "));
#ifdef Q_OS_WIN
    const QString bin = QStringLiteral("Recycle Bin");
#else
    const QString bin = QStringLiteral("Trash");
#endif
    QCOMPARE(ui::trTrash("无法移到回收站"), QStringLiteral("Can't Move to ") + bin);
    // Appended to a question, so it keeps its leading space.
    QCOMPARE(ui::trTrash("之后可以从回收站还原。"),
             QStringLiteral(" You can restore it from the %1 later.").arg(bin));
    QCOMPARE(ui::tr("\n\n当前打开的文档会被关闭。"),
             QStringLiteral("\n\nThe open document will be closed."));
    // The Rust core answers in the same language, with the same codes.
    const QJsonObject refused = bridge::createMarkdown(QStringLiteral("relative"), QString());
    QCOMPARE(refused.value("code").toString(), QStringLiteral("INVALID_ARGUMENT"));
    QCOMPARE(refused.value("message").toString(), QStringLiteral("Invalid path."));
    const QJsonObject created =
        bridge::createMarkdown(folder_ + QStringLiteral("/drafts"), QString());
    QVERIFY(created.value("ok").toBool());
    QCOMPARE(created.value("name").toString(), QStringLiteral("Untitled.md"));
    QVERIFY(QFile::remove(created.value("path").toString()));
    ui_language::apply(*qApp, Language::Chinese);
    QCOMPARE(ui::tr("全部替换"), QStringLiteral("全部替换"));
    QCOMPARE(
        bridge::createMarkdown(QStringLiteral("relative"), QString()).value("message").toString(),
        QStringLiteral("路径无效。"));
  }

  void englishTextInKeyWidgets() {
    prepare(Language::English);
    MainWindow w;
    open(w, QSize(1200, 760), true);
    auto* toolbar = w.findChild<Toolbar*>();
    QVERIFY(toolbar);
    QCOMPARE(named(toolbar, QStringLiteral("Open File"))->text(), QStringLiteral("Open"));
    QCOMPARE(named(toolbar, QStringLiteral("Save"))->text(), QStringLiteral("Save"));
    QVERIFY(named(toolbar, QStringLiteral("Find")));
    QVERIFY(named(toolbar, QStringLiteral("Sidebar")));
    QStringList modes;
    for (auto* button : w.findChild<SegmentedControl*>()->findChildren<QPushButton*>())
      modes << button->text();
    QCOMPARE(modes, (QStringList{QStringLiteral("Doc"), QStringLiteral("Source")}));
    QVERIFY(named(side(w), QStringLiteral("Files")));
    QVERIFY(named(side(w), QStringLiteral("Outline")));
    QVERIFY(named(side(w), QStringLiteral("Close Sidebar")));
    QVERIFY(named(panel(w), QStringLiteral("New Markdown File")));
    QVERIFY(named(panel(w), QStringLiteral("Open Folder")));
    QVERIFY(named(panel(w), QStringLiteral("Collapse All")));
    QStringList labels;
    for (auto* label : toolbar->findChildren<QLabel*>())
      labels << label->text();
    QVERIFY2(labels.contains(QStringLiteral("Markdown document")), qPrintable(labels.join('|')));
    w.openSearchPanel(true);
    QTest::qWait(300);
    auto* search = w.findChild<SearchPanel*>();
    QStringList placeholders;
    for (auto* edit : search->findChildren<QLineEdit*>())
      placeholders << edit->placeholderText();
    QCOMPARE(placeholders, (QStringList{QStringLiteral("Find"), QStringLiteral("Replace with")}));
    QStringList replaceButtons;
    for (auto* button : search->findChildren<QToolButton*>()) {
      if (!button->text().isEmpty()) replaceButtons << button->text();
    }
    QVERIFY2(replaceButtons.contains(QStringLiteral("Replace All")),
             qPrintable(replaceButtons.join('|')));
    QVERIFY(replaceButtons.contains(QStringLiteral("Replace")));
  }

  void labelsFitAtDefaultAndNarrowSizes_data() {
    QTest::addColumn<int>("language");
    QTest::addColumn<QSize>("size");
    for (Language language : {Language::Chinese, Language::English}) {
      const char* tag = language == Language::English ? "en" : "zh";
      // Default window, docked sidebar, and the narrow two-row toolbar.
      for (QSize size : {QSize(820, 900), QSize(1200, 760), QSize(640, 560)}) {
        QTest::newRow(
            qPrintable(QStringLiteral("%1 %2x%3").arg(tag).arg(size.width()).arg(size.height())))
            << int(language) << size;
      }
    }
  }
  void labelsFitAtDefaultAndNarrowSizes() {
    QFETCH(int, language);
    QFETCH(QSize, size);
    prepare(Language(language));
    shotPrefix_ += QStringLiteral("-%1x%2").arg(size.width()).arg(size.height());
    MainWindow w;
    open(w, size, false);
    QStringList problems = clipped(&w);
    QVERIFY2(problems.isEmpty(), qPrintable(QStringLiteral("main window: ") + problems.join("; ")));
    shot(&w, QStringLiteral("main"));

    // Sidebar: files, then outline.
    w.toggleSidebar();
    QTest::qWait(350);
    side(w)->setCurrentTab(SidePanel::Files);
    QTest::qWait(100);
    problems = clipped(&w);
    QVERIFY2(problems.isEmpty(), qPrintable(QStringLiteral("files: ") + problems.join("; ")));
    shot(&w, QStringLiteral("sidebar-files"));
    side(w)->setCurrentTab(SidePanel::Outline);
    QTest::qWait(100);
    problems = clipped(&w);
    QVERIFY2(problems.isEmpty(), qPrintable(QStringLiteral("outline: ") + problems.join("; ")));
    shot(&w, QStringLiteral("sidebar-outline"));

    // File context menu, on a file row.
    side(w)->setCurrentTab(SidePanel::Files);
    QTest::qWait(100);
    QTreeView* tree = panel(w)->tree();
    QTRY_VERIFY_WITH_TIMEOUT(panel(w)->indexForPath(other_).isValid(), 5000);
    const QModelIndex row = panel(w)->indexForPath(other_);
    tree->scrollTo(row);
    QStringList menuItems;
    QTimer::singleShot(300, this, [&] {
      auto* menu = qobject_cast<QMenu*>(QApplication::activePopupWidget());
      if (!menu) return;
      for (QAction* action : menu->actions()) {
        if (!action->isSeparator()) menuItems << action->text();
      }
      if (menu->width() < menu->sizeHint().width())
        problems << QStringLiteral("menu narrower than its items");
      shot(&w, QStringLiteral("context-menu"), menu);
      menu->close();
    });
    problems.clear();
    emit tree->customContextMenuRequested(tree->visualRect(row).center());
    QVERIFY2(problems.isEmpty(), qPrintable(problems.join("; ")));
    QCOMPARE(menuItems.size(), 4);
    if (Language(language) == Language::English) {
      QCOMPARE(menuItems, (QStringList{"New Markdown File", "Rename", "Delete", "Copy Path"}));
    }
    side(w)->setCurrentTab(SidePanel::Files);

    // Search and replace with matches, so the counter and replace actions show.
    if (side(w)->isVisible() && size.width() < 1024) w.toggleSidebar();
    QTest::qWait(300);
    w.openSearchPanel(true);
    QTest::qWait(300);
    auto* search = w.findChild<SearchPanel*>();
    search->findChildren<QLineEdit*>().first()->setText(QStringLiteral("Vellora"));
    QTest::qWait(400);
    problems = clipped(&w);
    QVERIFY2(problems.isEmpty(), qPrintable(QStringLiteral("search: ") + problems.join("; ")));
    shot(&w, QStringLiteral("search-replace"));
    search->setFeedback(ui::tr("已替换 %n 处", 12));
    QTest::qWait(100);
    problems = clipped(&w);
    QVERIFY2(problems.isEmpty(),
             qPrintable(QStringLiteral("search feedback: ") + problems.join("; ")));

    // Dialogs: replace all, delete, unsaved changes on quit. All keep their
    // buttons side by side and every label fits.
    answers_ = QStringList{QStringLiteral("取消"), QStringLiteral("Cancel")};
    for (auto* button : search->findChildren<QToolButton*>()) {
      if (button->text() == ui::tr("全部替换")) button->click();
    }
    QTRY_COMPARE_WITH_TIMEOUT(dialogButtons_.size(), 1, 5000);
    w.findChild<SearchPanel*>()->closePanel();
    QTest::qWait(250);
    emit panel(w)->deleteRequested(other_);
    QTRY_COMPARE_WITH_TIMEOUT(dialogButtons_.size(), 2, 5000);
    QVERIFY(QFileInfo::exists(other_));
    editBody(w);
    answers_ = QStringList{QStringLiteral("继续编辑"), QStringLiteral("Keep Editing")};
    w.close();
    QTRY_COMPARE_WITH_TIMEOUT(dialogButtons_.size(), 3, 5000);
    // Delete the open document with unsaved changes: the longest delete prompt.
    answers_ = QStringList{QStringLiteral("取消"), QStringLiteral("Cancel")};
    emit panel(w)->deleteRequested(guide_);
    QTRY_COMPARE_WITH_TIMEOUT(dialogButtons_.size(), 4, 5000);
    QVERIFY2(dialogProblems_.isEmpty(), qPrintable(dialogProblems_.join("; ")));
    if (Language(language) == Language::English) {
      QCOMPARE(dialogButtons_.at(0), QStringLiteral("Cancel|Replace All"));
      QCOMPARE(dialogButtons_.at(1), QStringLiteral("Cancel|Delete"));
      QCOMPARE(dialogButtons_.at(2), QStringLiteral("Keep Editing|Save and Quit|Don't Save"));
      QCOMPARE(dialogButtons_.at(3), QStringLiteral("Cancel|Discard and Delete"));
    }
  }

  void emptyStatesFit_data() {
    QTest::addColumn<int>("language");
    QTest::newRow("zh") << int(Language::Chinese);
    QTest::newRow("en") << int(Language::English);
  }
  void emptyStatesFit() {
    QFETCH(int, language);
    prepare(Language(language));
    MainWindow w;
    w.resize(1200, 760);
    w.show();
    QVERIFY(QTest::qWaitForWindowExposed(&w));
    if (!side(w)->isVisible()) w.toggleSidebar();
    QTest::qWait(350);
    side(w)->setCurrentTab(SidePanel::Files);
    QTest::qWait(100);
    const QStringList problems = clipped(&w);
    QVERIFY2(problems.isEmpty(), qPrintable(problems.join("; ")));
    shot(&w, QStringLiteral("empty"));
  }
};

QTEST_MAIN(I18nRegressions)
#include "i18n_regressions.moc"
