// Sidebar: one column with a file browser and the outline, switched by tabs.
// The file browser only lists entries. Opening, renaming and creating go through
// MainWindow and the Rust core, so the session and path rules still apply.
#pragma once

#include <QElapsedTimer>
#include <QFrame>
#include <QPersistentModelIndex>
#include <QPixmap>
#include <QSet>
#include <QTimer>

class OutlinePanel;
class QAbstractFileIconProvider;
class QStackedWidget;
class QFileSystemModel;
class QLabel;
class QLineEdit;
class QPushButton;
class QSortFilterProxyModel;
class QToolButton;
class QTreeView;
class QWidget;

class FileTreePanel : public QFrame {
  Q_OBJECT
 public:
  explicit FileTreePanel(QWidget* parent = nullptr);
  ~FileTreePanel() override;

  // Paths from the Rust core are canonical Windows paths ("\\?\C:\..."). Every
  // comparison in the panel goes through this normal form.
  static QString normalizedPath(QString path);
  // normalizedPath() plus, on Windows, 8.3 short names ("RUNNER~1") expanded
  // to the long names the Rust core reports. It touches the filesystem, so
  // only entry points that take an outside path call it, never painting.
  static QString expandedPath(const QString& path);
  static bool samePath(const QString& a, const QString& b);
  // True when `child` is strictly inside `parent`.
  static bool isInside(const QString& child, const QString& parent);

  void setRootPath(const QString& path);
  QString rootPath() const { return rootPath_; }
  // Shows the file's folder when no folder is open, then expands to the file.
  // A file outside an open folder leaves that folder as it is: only the user
  // changes it. It never shows the panel.
  void revealFile(const QString& path);
  void setCurrentFile(const QString& path, bool dirty);
  QString currentFile() const { return currentFile_; }
  bool isCurrentDirty() const { return currentDirty_; }
  bool isCurrentIndex(const QModelIndex& index) const;
  void applyTheme();
  void focusTree();

  // Windows denies renaming a folder while it, or a folder inside it, is
  // watched. Suspending drops the model and every watch with it; resuming
  // rebuilds it and keeps expanded folders, rebased across a folder rename.
  void suspendWatching();
  void resumeWatching(const QString& renamedFrom = QString(), const QString& renamedTo = QString());

  // Opens an inline name editor once the entry is listed. Enter or leaving the
  // field commits through renameRequested; Esc cancels.
  void beginRename(const QString& path);
  QLineEdit* renameEditor() const { return renameEditor_; }

  QTreeView* tree() const { return tree_; }
  QModelIndex indexForPath(const QString& path) const;
  QString pathForIndex(const QModelIndex& index) const;
  bool isDirectory(const QModelIndex& index) const;
  bool isExpandedIndex(const QModelIndex& index) const;
  QStringList visibleChildNames(const QString& directory) const;
  const QPixmap& glyph(int kind) const;

 signals:
  void fileActivated(const QString& path);
  void openFolderRequested();
  void newFileRequested(const QString& directory);
  void renameRequested(const QString& path, const QString& newName);

 protected:
  bool eventFilter(QObject* watched, QEvent* event) override;
  // The file model, and with it every directory watch, exists only while the
  // panel is shown. A hidden panel never holds a handle on the user's folders.
  void showEvent(QShowEvent* event) override;
  void hideEvent(QHideEvent* event) override;

 private:
  void rebuildModel();
  void releaseModel();
  void restoreExpanded();
  void expandAncestors(const QString& path);
  void applyReveal();
  void refreshHeader();
  void activate(const QModelIndex& index, bool fromMouse);
  void showContextMenu(const QPoint& position);
  QString targetDirectory(const QModelIndex& index) const;
  void tryBeginRename();
  void openRenameEditor(const QModelIndex& index, const QString& path);
  void positionRenameEditor();
  void commitRename(bool refocus);
  void cancelRename(bool refocus = false);
  void closeRenameEditor(bool refocus);

  QAbstractFileIconProvider* icons_ = nullptr;
  QFileSystemModel* model_ = nullptr;
  QSortFilterProxyModel* proxy_ = nullptr;
  QTreeView* tree_ = nullptr;
  QWidget* header_ = nullptr;
  QLabel* titleLabel_ = nullptr;
  QToolButton* newButton_ = nullptr;
  QToolButton* folderButton_ = nullptr;
  QToolButton* collapseButton_ = nullptr;
  QWidget* empty_ = nullptr;
  QLabel* emptyLabel_ = nullptr;
  QLabel* emptyHint_ = nullptr;
  QPushButton* emptyButton_ = nullptr;
  QLineEdit* renameEditor_ = nullptr;
  QPersistentModelIndex renameIndex_;
  QString renamePath_;
  QString pendingRename_;
  int renameAttempts_ = 0;
  QTimer renameTimer_;
  QString rootPath_;
  QString revealPending_;
  QString currentFile_;
  bool currentDirty_ = false;
  QSet<QString> expanded_;
  int pendingScroll_ = -1;
  bool pressOnBranch_ = false;
  QPersistentModelIndex lastToggle_;
  QElapsedTimer lastToggleClock_;
  QPixmap glyphs_[3];
};

// The sidebar column: the file panel and the outline behind two tabs, opened by
// a single toolbar toggle. Docked beside the document, or floating when narrow.
class SidePanel : public QFrame {
  Q_OBJECT
 public:
  enum Tab { Files = 0, Outline = 1 };
  explicit SidePanel(QWidget* parent = nullptr);

  FileTreePanel* files() const { return files_; }
  OutlinePanel* outline() const { return outline_; }
  Tab currentTab() const;
  // The tab the user chose. The outline needs an open document, so until one
  // is open the panel shows the files and returns to the outline afterwards.
  Tab preferredTab() const { return preferred_; }
  void setCurrentTab(Tab tab);
  void setOutlineAvailable(bool available);
  void setFloating(bool floating);
  bool isFloating() const { return floating_; }
  void applyTheme();
  void focusCurrent();

 signals:
  // The visible page changed, for any reason.
  void currentTabChanged(int tab);
  // The user picked a tab.
  void tabChosen(int tab);
  void closeRequested();

 private:
  void showTab(Tab tab);
  void refreshTabs();

  QToolButton* filesTab_ = nullptr;
  QToolButton* outlineTab_ = nullptr;
  QToolButton* closeButton_ = nullptr;
  QStackedWidget* stack_ = nullptr;
  FileTreePanel* files_ = nullptr;
  OutlinePanel* outline_ = nullptr;
  Tab preferred_ = Files;
  bool outlineAvailable_ = false;
  bool floating_ = false;
};
