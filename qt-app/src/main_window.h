// Main window coordinates the saved baseline, live draft and view histories.
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QMainWindow>
#include <QTextCursor>
#include <QTimer>
#include <QVector>
#include <functional>

class DocumentView;
class FileTreePanel;
class SidePanel;
class OutlinePanel;
class QStackedLayout;
class QHBoxLayout;
class SearchPanel;
class SourceView;
class Toolbar;

class MainWindow : public QMainWindow {
  Q_OBJECT
 public:
  explicit MainWindow(QWidget* parent = nullptr);
  // offerSave: the switch came from the file panel, so an unsaved document
  // offers "保存并切换" next to discarding.
  void openPath(const QString& path, bool sourceMode = false, bool offerSave = false);
  // Renames a Markdown file or a folder in place. When it is, or contains, the
  // open document, the session follows without reopening: the draft, undo
  // history, dirty state, scroll and selection are kept. Returns the bridge
  // result ({ok, path, name, isDir, sessionPath} or {ok: false, code, message}).
  QJsonObject renameEntry(const QString& path, const QString& newName);
  QString documentPath() const { return documentPath_; }
  // Shows a folder in the file panel and remembers it for the next launch.
  void openFolder(const QString& path);
  void toggleSidebar();
  // Restores the window size, last folder and sidebar preference from the
  // per-user store, or from Vellora.ini in portable mode (app_settings). Only
  // the application's main() calls it; a test that does isolates QSettings
  // first, so test windows never read or write user settings.
  void restoreWorkspace();
  void showSourceMode();
  bool splicePendingEdits(QString* content);
  void openSearchPanel(bool replaceMode);
  void applyTheme();
  bool isAsyncBusy() const { return opening_ || planning_ || !pendingOpenPath_.isEmpty(); }
#ifdef VELLORA_CONFLICT_TEST_HOOKS
  std::function<QJsonObject(const QString&, const QString&, const QString&)> conflictSaveHook;
  std::function<QJsonObject(const QString&)> conflictReloadHook;
#endif

 signals:
  void asyncIdle();

 protected:
  void closeEvent(QCloseEvent* event) override;
  void dragEnterEvent(QDragEnterEvent* event) override;
  void dropEvent(QDropEvent* event) override;
  void keyPressEvent(QKeyEvent* event) override;
  void resizeEvent(QResizeEvent* event) override;
  void showEvent(QShowEvent* event) override;
  bool eventFilter(QObject* watched, QEvent* event) override;

 private:
  void syncWindowFrameTheme();
  void buildUi();
  void chooseFile();
  void startOpen(std::function<QJsonObject()> openDocument, bool sourceMode);
  void finishAsync();
  bool save(QString conflictToken = QString());
  void applyDocument(const QJsonObject& payload);
  void setMode(int mode);
  void setModeWithPlan(int mode, const QJsonObject* precomputedPlan);
  void refreshIdentity();
  void markDirtyIfNeeded();
  void refreshOutline(const QJsonObject& plan);
  void refreshOutlineForDraft(bool force = false);
  void updateActiveHeading();
  void runSearch(bool forward = true);
  void refreshSearch(bool resetIndex = false);
  void showSourceMatch(int index);
  void replaceCurrent();
  void replaceAll();
  void closeSearch();
  void layoutSidebar();
  void setSidebarVisible(bool visible, bool remember);
  void sidebarShown();
  void showFiles(bool focus);
  void chooseFolder();
  void openFromTree(const QString& path);
  void renameFromTree(const QString& path, const QString& newName);
  void createFileIn(const QString& directory);
  void deleteFromTree(const QString& path);
  void moveFromTree(const QString& path, const QString& directory);
  // Warns first when a file uses relative links or images, then moves through
  // the core. The open document keeps its draft, undo history and scroll.
  void moveEntry(const QString& path, const QString& directory);
  // Asks, then deletes through the core; a second prompt before anything is
  // destroyed where the recycle bin cannot take it.
  void deleteEntry(const QString& path);
  QJsonObject removeEntry(const QString& path, bool permanent);
  // The core closed the session because the open document was deleted.
  void closeDeletedDocument();
  void saveWorkspace();
  bool confirmSwitch();
  void runTreeWork(bool showErrors);
  void discardFreshFiles(bool keepCurrent);
  void positionSearchPanel();
  void avoidSearchPanel();
  void showError(const QString& message);
  void showOpenError(const QString& message);
  void openLink(const QString& href);
  QString currentMarkdown() const;
  QString sourceMarkdown() const;
  bool collectDraft(bool showFailure = true);
  bool confirmDiscard();
  bool compositionActive() const;
  void afterComposition(std::function<void()> action);
  void notifyIfAsyncIdle();
  int ask(const QString& title, const QString& message, const QString& primary,
          const QString& secondary, bool destructive = false,
          const QString& tertiary = QString());

  Toolbar* toolbar_ = nullptr;
  QStackedLayout* stack_ = nullptr;
  DocumentView* documentView_ = nullptr;
  SourceView* sourceView_ = nullptr;
  SearchPanel* search_ = nullptr;
  SidePanel* side_ = nullptr;
  OutlinePanel* outline_ = nullptr;
  FileTreePanel* fileTree_ = nullptr;
  QWidget* content_ = nullptr;
  QWidget* body_ = nullptr;
  QHBoxLayout* bodyLayout_ = nullptr;
  bool sideFloating_ = false;
  bool sidePreferred_ = false;
  bool settingsEnabled_ = false;
  QString pendingTreeRename_;
  QString pendingTreeRenameReal_;
  // New files made from the file panel, as the core reports them, until the
  // user names, saves or keeps working in them. Removed again while still empty.
  QStringList freshFiles_;
  bool restoreSidebarPending_ = false;
  struct PendingRename {
    QString path;
    QString name;
  };
  // Renames typed in the file panel wait for busy work instead of being dropped.
  QVector<PendingRename> pendingRenames_;
  QStringList pendingErrors_;
  // A deletion asked for from the file panel, waiting for busy work and prompts.
  QString pendingDelete_;
  // A move dropped in the file panel, waiting like a deletion.
  QString pendingMovePath_;
  QString pendingMoveDirectory_;
  QTimer treeWorkTimer_;

  QString documentPath_;
  QString documentName_;
  QString savedMarkdown_;
  QString draftMarkdown_;
  // The document's pending edits always address the same original segment tree.
  // Saving does not rebuild that tree or clear its undo stack.
  QString documentBaselineMarkdown_;
  QString documentViewMarkdown_;
  QString sourceBaselineMarkdown_;
  QString lineEnding_ = QStringLiteral("\n");
  QString failure_;
  bool dirty_ = false;
  bool documentMode_ = true;
  bool applying_ = false;
  bool modalOpen_ = false;
  bool busy_ = false;
  bool opening_ = false;
  bool planning_ = false;
  bool savedFeedback_ = false;
  bool sourceVisited_ = false;
  bool deferredClose_ = false;
  bool refreshingSearch_ = false;
  quint64 session_ = 0;
  quint64 openRequestId_ = 0;
  QString pendingOpenPath_;
  bool pendingOpenSource_ = false;
  bool pendingOpenOfferSave_ = false;
  int documentScroll_ = 0;
  int sourceScroll_ = 0;
  int sourceTopInset_ = 32;
  int sourceSelectionStart_ = 0;
  int sourceSelectionEnd_ = 0;
  int sourceSearchIndex_ = -1;
  QString searchQuery_;
  QString outlineMarkdown_;
  bool outlineSynced_ = false;
  QVector<QTextCursor> sourceMatches_;
  QVector<int> sourceHeadingPositions_;
  QTimer dirtyTimer_;
  QTimer maximumDirtyTimer_;
  QTimer compositionTimer_;
  QTimer pendingOpenTimer_;
  QVector<std::function<void()>> compositionActions_;
  QJsonArray headings_;
};
