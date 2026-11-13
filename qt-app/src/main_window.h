// Main window coordinates the saved baseline, live draft and view histories.
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QMainWindow>
#include <QTextCursor>
#include <QTimer>
#include <QVector>
#include <functional>

class DocumentView;
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
  void openPath(const QString& path, bool sourceMode = false);
  void showSourceMode();
  bool splicePendingEdits(QString* content);
  void openSearchPanel(bool replaceMode);
#ifdef VELLORA_CONFLICT_TEST_HOOKS
  std::function<QJsonObject(const QString&, const QString&, const QString&)> conflictSaveHook;
  std::function<QJsonObject(const QString&)> conflictReloadHook;
#endif

 protected:
  void closeEvent(QCloseEvent* event) override;
  void dragEnterEvent(QDragEnterEvent* event) override;
  void dropEvent(QDropEvent* event) override;
  void keyPressEvent(QKeyEvent* event) override;
  void resizeEvent(QResizeEvent* event) override;
  bool eventFilter(QObject* watched, QEvent* event) override;

 private:
  void buildUi();
  void chooseFile();
  bool save(QString conflictToken = QString());
  void applyDocument(const QJsonObject& payload);
  void setMode(int mode);
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
  void toggleOutline();
  void layoutOutline();
  void positionSearchPanel();
  void showError(const QString& message);
  void showOpenError(const QString& message);
  void openLink(const QString& href);
  QString currentMarkdown() const;
  QString sourceMarkdown() const;
  bool collectDraft(bool showFailure = true);
  bool confirmDiscard();
  bool compositionActive() const;
  void afterComposition(std::function<void()> action);
  int ask(const QString& title, const QString& message, const QString& primary,
          const QString& secondary, bool destructive = false,
          const QString& tertiary = QString());

  Toolbar* toolbar_ = nullptr;
  QStackedLayout* stack_ = nullptr;
  DocumentView* documentView_ = nullptr;
  SourceView* sourceView_ = nullptr;
  SearchPanel* search_ = nullptr;
  OutlinePanel* outline_ = nullptr;
  QWidget* content_ = nullptr;
  QWidget* body_ = nullptr;
  QHBoxLayout* bodyLayout_ = nullptr;
  bool outlineFloating_ = false;

  QJsonObject plan_;
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
  bool savedFeedback_ = false;
  bool sourceVisited_ = false;
  bool deferredClose_ = false;
  bool refreshingSearch_ = false;
  quint64 session_ = 0;
  quint64 openRequestId_ = 0;
  QString pendingOpenPath_;
  bool pendingOpenSource_ = false;
  int documentScroll_ = 0;
  int sourceScroll_ = 0;
  int sourceTopInset_ = 32;
  int sourceSelectionStart_ = 0;
  int sourceSelectionEnd_ = 0;
  int sourceSearchIndex_ = -1;
  QString searchQuery_;
  QString outlineMarkdown_;
  QVector<QTextCursor> sourceMatches_;
  QVector<int> sourceHeadingPositions_;
  QTimer dirtyTimer_;
  QTimer maximumDirtyTimer_;
  QTimer compositionTimer_;
  QTimer pendingOpenTimer_;
  QVector<std::function<void()>> compositionActions_;
  QJsonArray headings_;
};
