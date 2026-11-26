#include "main_window.h"

#include <QApplication>
#include <utility>
#include <limits>
#include <QCloseEvent>
#include <QDragEnterEvent>
#include <QFileDialog>
#include <QDir>
#include <QFileInfo>
#include <QSettings>
#include <QFutureWatcher>
#include <QHash>
#include <QUrl>
#include <QtConcurrent/QtConcurrentRun>
#include <QHBoxLayout>
#include <QInputMethod>
#include <QKeyEvent>
#include <QLineEdit>
#include <QMimeData>
#include <QRegularExpression>
#include <QScopedValueRollback>
#include <QScrollBar>
#include <QShowEvent>
#include <QStackedLayout>
#include <QStyleHints>
#include <QTextBlock>
#include <QVBoxLayout>
#include <QtMath>
#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif

#include "app_settings.h"
#include "bridge.h"
#include "chrome.h"
#include "document_view.h"
#include "file_tree_panel.h"
#include "source_view.h"
#include "theme.h"

namespace {
constexpr int kModeDocument = 0;
constexpr int kModeSource = 1;
QString normalizedLines(QString text) {
  return text.replace(QStringLiteral("\r\n"), QStringLiteral("\n")).replace('\r', '\n');
}

int sourceOffsetForReadingAnchor(const QJsonObject& anchor, const QJsonObject& plan) {
  const QString current = normalizedLines(anchor.value("source").toString()).trimmed();

  if (current.isEmpty()) return -1;
  const int ordinal = anchor.value("ordinal").toInt(-1);
  const qreal ratio = qBound<qreal>(0, anchor.value("fraction").toDouble(), 1);
  int sourceStart = 0;
  int bestDistance = std::numeric_limits<int>::max();
  int bestOffset = -1;
  const auto blocks = plan.value("blocks").toArray();
  for (int index = 0; index < blocks.size(); ++index) {
    const auto block = blocks.at(index).toObject();
    const QString source = normalizedLines(block.value("source").toString());
    const QString key = source.trimmed();
    if (key == current) {
      const int distance = qAbs(block.value("segment").toInt(index) - ordinal);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestOffset = sourceStart + qRound(ratio * qMax(0, source.size() - 1));
      }
    }
    sourceStart += source.size();
  }
  return bestOffset;
}
}

MainWindow::MainWindow(QWidget* parent) : QMainWindow(parent) {
  setWindowTitle(QStringLiteral("Vellora"));
  resize(820, 900);
  setMinimumSize(640, 400);
  setAcceptDrops(true);
  buildUi();
  applyTheme();
  if (auto* hints = QGuiApplication::styleHints()) {
    connect(hints, &QStyleHints::colorSchemeChanged, this, &MainWindow::applyTheme);
  }
  dirtyTimer_.setSingleShot(true);
  dirtyTimer_.setInterval(120);
  maximumDirtyTimer_.setSingleShot(true);
  maximumDirtyTimer_.setInterval(500);
  const auto publishDraft = [this] {
    if (applying_ || opening_ || planning_ || compositionActive()) return;
    dirtyTimer_.stop();
    maximumDirtyTimer_.stop();
    collectDraft(false);
    refreshOutlineForDraft();
    if (search_->isVisible()) refreshSearch(false);
  };
  connect(&dirtyTimer_, &QTimer::timeout, this, publishDraft);
  connect(&maximumDirtyTimer_, &QTimer::timeout, this, publishDraft);
  compositionTimer_.setInterval(16);
  connect(&compositionTimer_, &QTimer::timeout, this, [this] {
    if (compositionActive()) return;
    compositionTimer_.stop();
    const auto actions = std::exchange(compositionActions_, {});
    for (const auto& action : actions) action();
  });
  pendingOpenTimer_.setInterval(40);
  connect(&pendingOpenTimer_, &QTimer::timeout, this, [this] {
    if (pendingOpenPath_.isEmpty()) { pendingOpenTimer_.stop(); return; }
    if (modalOpen_ || busy_ || opening_ || planning_ || compositionActive()) return;
    const QString path = std::exchange(pendingOpenPath_, QString());
    const bool source = pendingOpenSource_;
    const bool offerSave = pendingOpenOfferSave_;
    pendingOpenTimer_.stop();
    openPath(path, source, offerSave);
  });
  treeWorkTimer_.setInterval(40);
  connect(&treeWorkTimer_, &QTimer::timeout, this, [this] { runTreeWork(true); });
  qApp->installEventFilter(this);
}

void MainWindow::buildUi() {
  auto* central = new QWidget(this);
  auto* outer = new QVBoxLayout(central);
  outer->setContentsMargins(0, 0, 0, 0);
  outer->setSpacing(0);
  toolbar_ = new Toolbar(central);
  outer->addWidget(toolbar_);
  auto* body = new QWidget(central);
  body_ = body;
  auto* bodyLayout = new QHBoxLayout(body);
  bodyLayout_ = bodyLayout;
  bodyLayout->setContentsMargins(0, 0, 0, 0);
  bodyLayout->setSpacing(0);
  // Files and outline share one sidebar column behind two tabs.
  side_ = new SidePanel(body);
  side_->hide();
  bodyLayout->addWidget(side_);
  fileTree_ = side_->files();
  outline_ = side_->outline();
  content_ = new QWidget(body);
  stack_ = new QStackedLayout(content_);
  stack_->setContentsMargins(0, 0, 0, 0);
  documentView_ = new DocumentView(content_);
  documentView_->setObjectName(QStringLiteral("documentView"));
  documentView_->setEmptyState();
  sourceView_ = new SourceView(content_);
  sourceView_->setObjectName(QStringLiteral("sourceView"));
  stack_->addWidget(documentView_);
  stack_->addWidget(sourceView_);
  bodyLayout->addWidget(content_, 1);
  outer->addWidget(body, 1);
  setCentralWidget(central);
  search_ = new SearchPanel(content_);
  search_->hide();

  connect(toolbar_, &Toolbar::openRequested, this, &MainWindow::chooseFile);
  connect(toolbar_, &Toolbar::saveRequested, this, [this] { afterComposition([this] { save(); }); });
  connect(toolbar_, &Toolbar::searchRequested, this, [this] {
    if (search_->isVisible()) closeSearch(); else openSearchPanel(false);
  });
  connect(toolbar_, &Toolbar::sidebarRequested, this, &MainWindow::toggleSidebar);
  connect(side_, &SidePanel::closeRequested, this, [this] { setSidebarVisible(false, true); });
  connect(side_, &SidePanel::tabChosen, this, [this] { saveWorkspace(); });
  // Queued: the outline tab becomes available from inside refreshIdentity().
  connect(side_, &SidePanel::currentTabChanged, this, [this] { sidebarShown(); }, Qt::QueuedConnection);
  connect(fileTree_, &FileTreePanel::openFolderRequested, this, &MainWindow::chooseFolder);
  connect(fileTree_, &FileTreePanel::fileActivated, this, &MainWindow::openFromTree);
  connect(fileTree_, &FileTreePanel::renameRequested, this, &MainWindow::renameFromTree);
  connect(fileTree_, &FileTreePanel::deleteRequested, this, &MainWindow::deleteFromTree);
  connect(fileTree_, &FileTreePanel::moveRequested, this, &MainWindow::moveFromTree);
  connect(fileTree_, &FileTreePanel::newFileRequested, this, &MainWindow::createFileIn);
  connect(toolbar_, &Toolbar::modeChanged, this, &MainWindow::setMode);
  connect(documentView_, &DocumentView::openRequested, this, &MainWindow::chooseFile);
  connect(documentView_, &DocumentView::linkActivated, this, &MainWindow::openLink);
  connect(sourceView_, &QPlainTextEdit::textChanged, this, [this] {
    if (applying_ || documentMode_) return;
    failure_.clear();
    savedFeedback_ = false;
    search_->setFeedback(QString());
    draftMarkdown_ = sourceMarkdown();
    if (!outline_->isVisible() && outlineMarkdown_ != draftMarkdown_) {
      outlineMarkdown_.clear();
      outlineSynced_ = false;
    }
    dirty_ = compositionActive() || draftMarkdown_ != savedMarkdown_;
    refreshIdentity();
    dirtyTimer_.start();
    if (!maximumDirtyTimer_.isActive()) maximumDirtyTimer_.start();
  });
  connect(documentView_, &DocumentView::contentEdited, this, [this] {
    if (applying_ || !documentMode_) return;
    // Optimistically protect the document immediately, including a close in
    // the same input turn. The debounced serializer then handles undo-to-clean.
    dirty_ = true;
    failure_.clear();
    savedFeedback_ = false;
    search_->setFeedback(QString());
    refreshIdentity();
    dirtyTimer_.start();
    if (!maximumDirtyTimer_.isActive()) maximumDirtyTimer_.start();
  });
  connect(sourceView_, &SourceView::compositionStateChanged, this, [this](bool composing) {
    if (composing) { dirty_ = true; savedFeedback_ = false; refreshIdentity(); }
    else dirtyTimer_.start();
  });
  connect(search_, &SearchPanel::queryChanged, this, [this](const QString&) { refreshSearch(true); });
  connect(search_, &SearchPanel::navigateRequested, this, [this](int delta) {
    if (documentMode_) {
      if (documentView_->searchMatchCount() > 0)
        documentView_->focusSearchResult(documentView_->searchActiveIndex() + delta);
      search_->setCounter(documentView_->searchActiveIndex() + 1, documentView_->searchMatchCount());
      avoidSearchPanel();
    } else {
      showSourceMatch(sourceSearchIndex_ + delta);
    }
  });
  connect(search_, &SearchPanel::replaceRequested, this, &MainWindow::replaceCurrent);
  connect(search_, &SearchPanel::replaceAllRequested, this, &MainWindow::replaceAll);
  connect(search_, &SearchPanel::replaceToggled, this, [this](bool open) {
    search_->setReplaceVisible(open);
    positionSearchPanel();
  });
  connect(search_, &SearchPanel::closed, this, &MainWindow::closeSearch);
  connect(outline_, &OutlinePanel::headingSelected, this, [this](int index) {
    if (index < 0 || index >= headings_.size()) return;
    if (documentMode_) documentView_->revealHeading(index);
    else if (index < sourceHeadingPositions_.size()) {
      QTextCursor cursor(sourceView_->document());
      cursor.setPosition(qBound(0, sourceHeadingPositions_.at(index), sourceView_->document()->characterCount()-1));
      sourceView_->setTextCursor(cursor);
      sourceView_->ensureCursorVisible();
    }
    outline_->setCurrentHeading(index);
    if (sideFloating_) setSidebarVisible(false, false);
  });
  connect(documentView_->verticalScrollBar(), &QScrollBar::valueChanged, this, [this] { updateActiveHeading(); });
  connect(sourceView_->verticalScrollBar(), &QScrollBar::valueChanged, this, [this] { updateActiveHeading(); });
  refreshIdentity();
}

bool MainWindow::compositionActive() const {
  return (search_ && search_->isComposing()) || (documentMode_ ? documentView_->isComposing() : sourceView_->isComposing());
}

void MainWindow::afterComposition(std::function<void()> action) {
  if (modalOpen_ || busy_ || opening_ || planning_) return;
  if (!compositionActive()) { action(); return; }
  const quint64 expectedSession = session_;
  compositionActions_.append([this, expectedSession, action] {
    if (session_ == expectedSession && !modalOpen_ && !busy_ && !opening_ && !planning_) action();
  });
  compositionTimer_.start();
  if (QGuiApplication::inputMethod()) QGuiApplication::inputMethod()->commit();
}

int MainWindow::ask(const QString& title, const QString& message, const QString& primary,
                    const QString& secondary, bool destructive, const QString& tertiary) {
  if (modalOpen_) return 1;
  QScopedValueRollback<bool> modal(modalOpen_, true);
  return ModalDialog::ask(this, title, message, primary, secondary, destructive, tertiary);
}

bool MainWindow::confirmDiscard() {
  if (!collectDraft()) return false;
  if (!dirty_) return true;
  return ask(QStringLiteral("未保存更改"), QStringLiteral("当前文档有未保存更改。"),
             QStringLiteral("放弃更改"), QStringLiteral("继续编辑"), true) == 2;
}

bool MainWindow::confirmSwitch() {
  if (!collectDraft()) return false;
  if (!dirty_) return true;
  const int answer = ask(QStringLiteral("未保存更改"), QStringLiteral("当前文档有未保存更改。切换前要保存吗？"),
                         QStringLiteral("保存并切换"), QStringLiteral("继续编辑"), false,
                         QStringLiteral("放弃更改"));
  if (answer == 2) return save();
  return answer == 3;
}

void MainWindow::notifyIfAsyncIdle() {
  if (!isAsyncBusy()) emit asyncIdle();
}

void MainWindow::finishAsync() {
  opening_ = false;
  planning_ = false;
  refreshIdentity();
  notifyIfAsyncIdle();
}

void MainWindow::chooseFile() {
  if (isAsyncBusy()) return;
  const quint64 request = ++openRequestId_;
  afterComposition([this, request] {
    pendingOpenPath_.clear();
    pendingOpenTimer_.stop();
    if (!confirmDiscard() || request != openRequestId_) return;
    QString path;
    {
      QScopedValueRollback<bool> modal(modalOpen_, true);
      path = QFileDialog::getOpenFileName(this, QStringLiteral("打开 Markdown 文件"),
          QString(), QStringLiteral("Markdown 文件 (*.md *.markdown)"));
    }
    if (path.isEmpty() || request != openRequestId_) return;
    startOpen([path] { return bridge::openDocument(path); }, false);
  });
}

void MainWindow::openPath(const QString& path, bool sourceMode, bool offerSave) {
  if (path.isEmpty()) return;
  const quint64 request = ++openRequestId_;
  if (modalOpen_ || busy_ || opening_ || planning_) {
    // A started native open already owns the Rust session. Apply its result
    // before attempting the latest queued path, including when that path fails.
    pendingOpenPath_ = path;
    pendingOpenSource_ = sourceMode;
    pendingOpenOfferSave_ = offerSave;
    pendingOpenTimer_.start();
    return;
  }
  pendingOpenPath_.clear();
  pendingOpenTimer_.stop();
  if (compositionActive()) {
    // Earlier IME-deferred actions may start a plan. Re-enter the open queue
    // when this request runs instead of dropping it through the generic gate.
    compositionActions_.append([this, path, sourceMode, offerSave, request] {
      if (request == openRequestId_) openPath(path, sourceMode, offerSave);
    });
    compositionTimer_.start();
    if (QGuiApplication::inputMethod()) QGuiApplication::inputMethod()->commit();
    return;
  }
  const bool discard = offerSave ? confirmSwitch() : confirmDiscard();
  if (request != openRequestId_) return;
  if (!discard) {
    refreshIdentity();
    notifyIfAsyncIdle();
    return;
  }
  startOpen([path] { return bridge::openDocument(path); }, sourceMode);
}

QJsonObject MainWindow::renameEntry(const QString& path, const QString& newName) {
  // A save, open, plan, prompt or IME composition owns the session path while it
  // runs. Renaming underneath it would retarget work that has already started.
  if (modalOpen_ || busy_ || isAsyncBusy() || compositionActive()) {
    return QJsonObject{{"ok", false}, {"code", "BUSY"},
                       {"message", QStringLiteral("当前文档正在处理中，请稍后再重命名。")}};
  }
  // Windows refuses to rename a folder the file panel is watching.
  const bool folder = QFileInfo(path).isDir();
  if (folder) fileTree_->suspendWatching();
  const QJsonObject result = bridge::renameEntry(path, newName);
  if (folder) {
    const bool renamed = result.value("ok").toBool();
    fileTree_->resumeWatching(renamed ? path : QString(), renamed ? result.value("path").toString() : QString());
  }
  const QString sessionPath = result.value("sessionPath").toString();
  if (result.value("ok").toBool()) {
    // A new file the user named, or moved with its folder, is theirs to keep.
    freshFiles_.removeIf([&](const QString& fresh) {
      return FileTreePanel::samePath(fresh, path) || FileTreePanel::isInside(fresh, path) ||
             (!sessionPath.isEmpty() && FileTreePanel::samePath(fresh, documentPath_));
    });
  }
  if (!result.value("ok").toBool() || sessionPath.isEmpty() || documentPath_.isEmpty()) return result;
  // Only the identity changes. applyDocument() would rebuild the view and drop
  // the draft, undo history and scroll position.
  documentPath_ = sessionPath;
  if (!result.value("isDir").toBool()) documentName_ = result.value("name").toString();
  documentView_->setDocumentPath(sessionPath);
  refreshIdentity();
  fileTree_->revealFile(sessionPath);
  return result;
}

void MainWindow::startOpen(std::function<QJsonObject()> openDocument, bool sourceMode) {
  opening_ = true;
  dirtyTimer_.stop();
  maximumDirtyTimer_.stop();
  refreshIdentity();
  toolbar_->repaint();
  auto* watcher = new QFutureWatcher<QJsonObject>(this);
  connect(watcher, &QFutureWatcher<QJsonObject>::finished, this,
          [this, watcher, sourceMode] {
            const QJsonObject payload = watcher->result();
            watcher->deleteLater();
            if (payload.value("ok").toBool()) {
              applyDocument(payload);
              opening_ = false;
              if (sourceMode) {
                const QJsonObject openedPlan = payload.value("plan").toObject();
                setModeWithPlan(kModeSource, &openedPlan);
                return;
              }
            } else {
              opening_ = false;
              showOpenError(payload.value("message").toString());
            }
            finishAsync();
          });
  watcher->setFuture(QtConcurrent::run(std::move(openDocument)));
}
void MainWindow::applyDocument(const QJsonObject& payload) {
  QScopedValueRollback<bool> applying(applying_, true);
  dirtyTimer_.stop();
  maximumDirtyTimer_.stop();
  ++session_;
  deferredClose_ = false;
  compositionActions_.clear();
  const QJsonObject document = payload.value("document").toObject();
  documentPath_ = document.value("path").toString();
  documentName_ = document.value("name").toString();
  savedMarkdown_ = document.value("content").toString();
  draftMarkdown_ = savedMarkdown_;
  documentBaselineMarkdown_ = savedMarkdown_;
  documentViewMarkdown_ = savedMarkdown_;
  sourceBaselineMarkdown_ = savedMarkdown_;
  lineEnding_ = payload.value("lineEnding").toString(QStringLiteral("\n"));
  const QJsonObject plan = payload.value("plan").toObject();
  documentView_->setPlan(plan, documentPath_);
  documentView_->setPreviewContext(draftMarkdown_);
  sourceView_->setMarkdown(savedMarkdown_);
  dirty_ = false;
  savedFeedback_ = false;
  failure_.clear();
  documentMode_ = true;
  sourceVisited_ = false;
  sourceScroll_ = documentScroll_ = sourceSelectionStart_ = sourceSelectionEnd_ = 0;
  sourceTopInset_ = 32;
  toolbar_->setMode(kModeDocument);
  stack_->setCurrentWidget(documentView_);
  closeSearch();
  for (auto* field : search_->findChildren<QLineEdit*>()) field->clear();
  searchQuery_.clear();
  sourceMatches_.clear();
  sourceSearchIndex_ = -1;
  // The sidebar stays open: its file panel is how documents are switched.
  refreshOutline(plan);
  updateActiveHeading();
  refreshIdentity();
  documentView_->setFocus();
  const QString folderBefore = fileTree_->rootPath();
  fileTree_->revealFile(documentPath_);
  // The panel followed the document to another folder: remember it.
  if (fileTree_->rootPath() != folderBefore) saveWorkspace();
  // Switching away leaves a new file abandoned: remove it while still empty.
  discardFreshFiles(true);
  if (!pendingTreeRename_.isEmpty()) {
    const QString created = std::exchange(pendingTreeRename_, QString());
    const QString real = std::exchange(pendingTreeRenameReal_, QString());
    // The tree lists the folder as the user opened it, links included.
    if (FileTreePanel::samePath(real, documentPath_)) fileTree_->beginRename(created);
  }
}

void MainWindow::showSourceMode() { setMode(kModeSource); }

QString MainWindow::sourceMarkdown() const {
  const QString text = sourceView_->markdown();
  if (text == normalizedLines(sourceBaselineMarkdown_)) return sourceBaselineMarkdown_;
  QString content = normalizedLines(text);
  if (lineEnding_ == QStringLiteral("\r\n")) content.replace(QStringLiteral("\n"), QStringLiteral("\r\n"));
  return content;
}

QString MainWindow::currentMarkdown() const {
  return documentMode_ ? draftMarkdown_ : sourceMarkdown();
}

bool MainWindow::splicePendingEdits(QString* content) {
  if (content == nullptr) return false;
  *content = documentBaselineMarkdown_;
  const auto pending = documentView_->pendingEdits();
  if (pending.isEmpty()) return true;
  QJsonArray edits;
  for (const auto& edit : pending) edits.append(QJsonObject{{"index", edit.first}, {"markdown", edit.second}});
  const QJsonObject spliced = bridge::spliceSegments(documentBaselineMarkdown_, edits);
  if (!spliced.value("ok").toBool() || spliced.value("applied").toInt(-1) != edits.size()) {
    failure_ = spliced.value("message").toString(QStringLiteral("文档无法完整序列化，草稿已保留。"));
    return false;
  }
  *content = spliced.value("content").toString();
  return true;
}

bool MainWindow::collectDraft(bool showFailure) {
  if (documentPath_.isEmpty()) { dirty_ = false; return true; }
  if (compositionActive()) { dirty_ = true; return false; }
  QString content;
  if (documentMode_) {
    if (!splicePendingEdits(&content)) {
      dirty_ = true;
      refreshIdentity();
      if (showFailure) showError(failure_);
      return false;
    }
    documentViewMarkdown_ = content;
  } else content = sourceMarkdown();
  draftMarkdown_ = content;
  if (!outline_->isVisible() && outlineMarkdown_ != draftMarkdown_) {
    outlineMarkdown_.clear();
    outlineSynced_ = false;
  }
  documentView_->setPreviewContext(draftMarkdown_);
  failure_.clear();
  dirty_ = draftMarkdown_ != savedMarkdown_;
  refreshIdentity();
  return true;
}

void MainWindow::setMode(int mode) {
  if (isAsyncBusy()) return;
  setModeWithPlan(mode, nullptr);
}

void MainWindow::setModeWithPlan(int mode, const QJsonObject* precomputedPlan) {
  if (documentPath_.isEmpty() || modalOpen_ || busy_ || opening_ || planning_) return;
  const bool toSource = mode == kModeSource;
  if (toSource == !documentMode_) { toolbar_->setMode(mode); return; }
  toolbar_->setMode(documentMode_ ? kModeDocument : kModeSource);
  const bool hasPrecomputed = precomputedPlan != nullptr;
  const QJsonObject immediatePlan = hasPrecomputed ? *precomputedPlan : QJsonObject();
  afterComposition([this, toSource, hasPrecomputed, immediatePlan] {
    if (toSource == !documentMode_ || !collectDraft()) return;
    auto finishSwitch = [this](bool nowSource) {
      toolbar_->setMode(nowSource ? kModeSource : kModeDocument);
      refreshOutlineForDraft();
      if (search_->isVisible()) refreshSearch(true);
      finishAsync();
    };
    if (toSource) {
      const QJsonObject anchor = sourceVisited_ ? QJsonObject() : documentView_->readingAnchor();
      documentScroll_ = documentView_->scrollValue();
      const qreal ratio = qreal(documentScroll_) / qMax(1, documentView_->verticalScrollBar()->maximum());
      auto applySourceSwitch = [this, ratio, finishSwitch](int initialOffset) {
        if (sourceMarkdown() != draftMarkdown_) {
          sourceBaselineMarkdown_ = draftMarkdown_;
          sourceView_->setMarkdown(draftMarkdown_);
        }
        documentMode_ = false;
        stack_->setCurrentWidget(sourceView_);
        QTextCursor selection(sourceView_->document());
        const int maximum = sourceView_->document()->characterCount() - 1;
        selection.setPosition(qBound(0, sourceSelectionStart_, maximum));
        selection.setPosition(qBound(0, sourceSelectionEnd_, maximum), QTextCursor::KeepAnchor);
        sourceView_->setTextCursor(selection);
        if (sourceVisited_) {
          sourceView_->restoreTopInset(sourceTopInset_);
          sourceView_->verticalScrollBar()->setValue(sourceScroll_);
        } else if (initialOffset >= 0) {
          const quint64 expectedSession = session_;
          // Source margins and wrapping finish after the stacked widget is shown.
          QTimer::singleShot(0, this, [this, initialOffset, expectedSession] {
            if (session_ == expectedSession && !documentMode_ && !compositionActive())
              sourceView_->revealOffset(initialOffset);
          });
        } else {
          sourceView_->verticalScrollBar()->setValue(qRound(ratio * sourceView_->verticalScrollBar()->maximum()));
        }
        sourceVisited_ = true;
        sourceView_->setFocus();
        finishSwitch(true);
      };
      if (sourceVisited_) {
        applySourceSwitch(-1);
        return;
      }
      if (hasPrecomputed) {
        applySourceSwitch(sourceOffsetForReadingAnchor(anchor, immediatePlan));
        return;
      }
      const QString markdown = draftMarkdown_;
      planning_ = true;
      dirtyTimer_.stop();
      maximumDirtyTimer_.stop();
      refreshIdentity();
      auto* watcher = new QFutureWatcher<QJsonObject>(this);
      connect(watcher, &QFutureWatcher<QJsonObject>::finished, this,
              [this, watcher, anchor, applySourceSwitch] {
                const QJsonObject parsed = watcher->result();
                watcher->deleteLater();
                planning_ = false;
                if (!parsed.value("ok").toBool()) {
                  refreshIdentity();
                  showError(parsed.value("message").toString());
                  finishAsync();
                  return;
                }
                applySourceSwitch(sourceOffsetForReadingAnchor(anchor, parsed.value("plan").toObject()));
              });
      watcher->setFuture(QtConcurrent::run([markdown] { return bridge::planFor(markdown); }));
    } else {
      sourceScroll_ = sourceView_->verticalScrollBar()->value();
      sourceTopInset_ = sourceView_->topInset();
      sourceSelectionStart_ = sourceView_->textCursor().anchor();
      sourceSelectionEnd_ = sourceView_->textCursor().position();
      auto applyDocumentSwitch = [this, finishSwitch] {
        documentMode_ = true;
        stack_->setCurrentWidget(documentView_);
        documentView_->setScrollValue(documentScroll_);
        documentView_->setFocus();
        finishSwitch(false);
      };
      if (draftMarkdown_ == documentViewMarkdown_) {
        applyDocumentSwitch();
        return;
      }
      const QString markdown = draftMarkdown_;
      const auto documentSelection = documentView_->selectionState();
      planning_ = true;
      dirtyTimer_.stop();
      maximumDirtyTimer_.stop();
      refreshIdentity();
      auto* watcher = new QFutureWatcher<QJsonObject>(this);
      connect(watcher, &QFutureWatcher<QJsonObject>::finished, this,
              [this, watcher, markdown, documentSelection, applyDocumentSwitch] {
                const QJsonObject result = watcher->result();
                watcher->deleteLater();
                planning_ = false;
                if (!result.value("ok").toBool()) {
                  refreshIdentity();
                  showError(result.value("message").toString());
                  finishAsync();
                  return;
                }
                const QJsonObject plan = result.value("plan").toObject();
                documentBaselineMarkdown_ = markdown;
                documentViewMarkdown_ = markdown;
                documentView_->setPlan(plan, documentPath_);
                documentView_->setPreviewContext(markdown);
                documentView_->restoreSelectionState(documentSelection);
                applyDocumentSwitch();
              });
      watcher->setFuture(QtConcurrent::run([markdown] { return bridge::planFor(markdown); }));
    }
  });
}

void MainWindow::refreshIdentity() {
  const QString status = opening_ ? QStringLiteral("正在打开文件")
      : busy_ ? QStringLiteral("正在保存")
      : !failure_.isEmpty() ? failure_ : savedFeedback_ ? QStringLiteral("已保存")
      : documentPath_.isEmpty() ? QStringLiteral("未打开文件")
      : dirty_ ? QStringLiteral("有未保存更改") : QStringLiteral("Markdown 文档");
  toolbar_->setDocumentName(documentName_, status, dirty_);
  toolbar_->setDocumentAvailable(!documentPath_.isEmpty());
  toolbar_->setBusy(busy_ || isAsyncBusy());
  toolbar_->setSaveEnabled(!documentPath_.isEmpty() && dirty_ && !busy_ && !isAsyncBusy());
  documentView_->setReadOnly(isAsyncBusy());
  sourceView_->setReadOnly(isAsyncBusy());
  setWindowTitle(QStringLiteral("Vellora"));
  if (fileTree_) fileTree_->setCurrentFile(documentPath_, dirty_);
  if (side_) side_->setOutlineAvailable(!documentPath_.isEmpty());
}

void MainWindow::markDirtyIfNeeded() { collectDraft(false); }

bool MainWindow::save(QString conflictToken) {
  if (documentPath_.isEmpty() || modalOpen_ || busy_ || isAsyncBusy() || compositionActive() || !collectDraft()) return false;
  const QString path = documentPath_;
  const quint64 expectedSession = session_;
  const auto current = [this, path, expectedSession] {
    return session_ == expectedSession && documentPath_ == path;
  };
  const auto attempt = [this, path, current](bool reload, const QString& token) -> QJsonObject {
    if (!current() || busy_ || compositionActive()) return {};
    if (!reload && !collectDraft(false))
      return QJsonObject{{"ok", false}, {"message", failure_}};
    const QString content = draftMarkdown_;
    QJsonObject result;
    {
      QScopedValueRollback<bool> busy(busy_, true);
      QScopedValueRollback<bool> opening(opening_, reload);
      refreshIdentity(); toolbar_->repaint();
#ifdef VELLORA_CONFLICT_TEST_HOOKS
      if (reload && conflictReloadHook) result = conflictReloadHook(path);
      else if (!reload && conflictSaveHook) result = conflictSaveHook(path, content, token);
      else
#endif
      result = reload ? bridge::openDocument(path) : bridge::saveDocument(path, content, token);
    }
    if (!current()) return {};
    if (result.value("ok").toBool()) {
      if (reload) {
        applyDocument(result);
      } else {
        savedMarkdown_ = content;
        savedFeedback_ = true;
        freshFiles_.removeIf([this](const QString& fresh) { return FileTreePanel::samePath(fresh, documentPath_); });
        // Preserve both view histories and their original segment baselines.
        collectDraft(false);
        failure_.clear();
      }
    } else if (result.value("code").toString() == QStringLiteral("FILE_CHANGED")) {
      failure_.clear();
      savedFeedback_ = false;
    } else {
      failure_ = result.value("message").toString();
      savedFeedback_ = false;
    }
    refreshIdentity();
    return result;
  };
  const QJsonObject result = attempt(false, conflictToken);
  if (!current()) return false;
  if (result.value("ok").toBool()) return !dirty_;
  if (result.value("code").toString() == QStringLiteral("FILE_CHANGED") &&
      !result.value("conflictToken").toString().isEmpty()) {
    QScopedValueRollback<bool> modal(modalOpen_, true);
    const int answer = ModalDialog::resolveConflict(this, result, attempt, current);
    refreshIdentity();
    // Reload never authorizes an enclosing save-and-close operation.
    return answer == 2 && current() && !dirty_;
  }
  showError(failure_);
  return false;
}

void MainWindow::showOpenError(const QString& message) {
  pendingTreeRename_.clear();
  pendingTreeRenameReal_.clear();
  discardFreshFiles(true);
  failure_ = message;
  savedFeedback_ = false;
  refreshIdentity();
  if (documentPath_.isEmpty()) {
    documentView_->setErrorState(message);
    stack_->setCurrentWidget(documentView_);
  } else showError(message);
}

void MainWindow::showError(const QString& message) {
  if (message.isEmpty()) return;
  ask(QStringLiteral("Vellora"), message, QStringLiteral("知道了"), QString());
}

void MainWindow::openLink(const QString& href) {
  if (isAsyncBusy()) return;
  const quint64 initialRequest = openRequestId_;
  afterComposition([this, href, initialRequest] {
    if (documentPath_.isEmpty() || href.isEmpty()) return;
    if (href.startsWith('#')) {
      collectDraft(false);
      refreshOutlineForDraft(true);
      const QString target = QUrl::fromPercentEncoding(href.mid(1).toUtf8());
      for (int i=0;i<headings_.size();++i) {
        if (headings_[i].toObject().value("id").toString() == target) { documentView_->revealHeading(i); return; }
      }
      return;
    }
    const QJsonObject inspected = bridge::inspectLink(documentPath_, href);
    if (!inspected.value("ok").toBool()) { showError(inspected.value("message").toString()); return; }
    if (inspected.value("action").toString() == QStringLiteral("external")) {
      const QString url = inspected.value("url").toString();
      if (ask(QStringLiteral("安全提示"), QStringLiteral("您即将访问外部链接，确认离开此应用程序吗？\n\n%1").arg(url),
              QStringLiteral("继续访问"), QStringLiteral("取消")) != 2) return;
      const QJsonObject opened = bridge::openExternal(url);
      if (!opened.value("ok").toBool()) showError(opened.value("message").toString());
    } else {
      if (initialRequest != openRequestId_) return;
      const QString originDocument = documentPath_;
      const quint64 expectedSession = session_;
      const quint64 request = ++openRequestId_;
      const bool discard = confirmDiscard();
      if (request != openRequestId_ || session_ != expectedSession || documentPath_ != originDocument) return;
      if (!discard) {
        refreshIdentity();
        notifyIfAsyncIdle();
        return;
      }
      startOpen([originDocument, href] { return bridge::openLink(originDocument, href); }, false);
    }
  });
}

void MainWindow::refreshOutlineForDraft(bool force) {
  if (documentPath_.isEmpty() || (!force && !outline_->isVisible()) ||
      (outlineSynced_ && outlineMarkdown_ == draftMarkdown_))
    return;
  const QJsonObject result = bridge::planFor(draftMarkdown_);
  if (result.value("ok").toBool()) refreshOutline(result.value("plan").toObject());
}

void MainWindow::refreshOutline(const QJsonObject& plan) {
  outlineMarkdown_ = draftMarkdown_;
  outlineSynced_ = true;
  headings_ = QJsonArray();
  sourceHeadingPositions_.clear();
  QHash<QString, int> ids;
  // The parser supplies normalized-LF UTF-16 source offsets. Visible text is
  // not a valid source locator: duplicates, inline marks and HTML all differ.
  for (const auto& value : plan.value("outline").toArray()) {
    const QJsonObject heading = value.toObject();
    const QString text = heading.value("text").toString();
    QString id = text.normalized(QString::NormalizationForm_KC).toLower().trimmed();
    id.remove(QRegularExpression(QStringLiteral("[^\\p{L}\\p{N}\\s_-]")));
    id.replace(QRegularExpression(QStringLiteral("\\s+")), QStringLiteral("-"));
    id.replace(QRegularExpression(QStringLiteral("-+")), QStringLiteral("-"));
    if (id.startsWith('-')) id.remove(0, 1);
    if (id.endsWith('-')) id.chop(1);
    id = QStringLiteral("heading-") + (id.isEmpty() ? QStringLiteral("heading") : id);
    const int occurrence = ++ids[id];
    const QString unique = occurrence > 1 ? id + QStringLiteral("-%1").arg(occurrence) : id;
    headings_.append(QJsonObject{{"level", heading.value("level").toInt(1)},
                                 {"text", text}, {"id", unique}});
    sourceHeadingPositions_.append(qMax(0, heading.value("sourceOffset").toInt()));
  }
  outline_->setHeadings(headings_);
  updateActiveHeading();
}
void MainWindow::updateActiveHeading() {
  if (!outline_->isVisible() || headings_.isEmpty()) return;
  if (documentMode_) { outline_->setCurrentHeading(documentView_->currentHeadingIndex()); return; }
  const int top = sourceView_->cursorForPosition(QPoint(0,0)).position();
  int index=0;
  for(int i=0;i<sourceHeadingPositions_.size();++i) {
    if(sourceHeadingPositions_[i]<=top) index=i; else break;
  }
  outline_->setCurrentHeading(index);
}

void MainWindow::openSearchPanel(bool replaceMode) {
  if (documentPath_.isEmpty() || modalOpen_ || busy_ || compositionActive()) return;
  QWidget* editor = documentMode_ ? static_cast<QWidget*>(documentView_) : sourceView_;
  QWidget* focused = QApplication::focusWidget();
  QString selection;
  if (focused == editor || (focused && editor->isAncestorOf(focused)))
    selection = documentMode_ ? documentView_->selectedText() : sourceView_->selectedText();
  if (selection.trimmed().isEmpty() || selection.contains(QRegularExpression(QStringLiteral("[\r\n\u2028\u2029]")))) selection.clear();
  toolbar_->setSearchChecked(true);
  search_->openWith(replaceMode,replaceMode ? QString() : selection);
  refreshSearch(true);
  positionSearchPanel();
}

void MainWindow::refreshSearch(bool resetIndex) {
  if (refreshingSearch_ || !search_->isVisible()) return;
  QScopedValueRollback<bool> refreshing(refreshingSearch_,true);
  const QString query=search_->query().trimmed();
  const bool queryChanged=query!=searchQuery_;
  searchQuery_=query;
  if(documentMode_) {
    const int previous=documentView_->searchActiveIndex();
    documentView_->setSearchQuery(query,true);
    if(!resetIndex && !queryChanged && previous>=0) documentView_->focusSearchResult(previous);
    search_->setCounter(documentView_->searchActiveIndex()+1,documentView_->searchMatchCount());
  } else {
    sourceMatches_.clear();
    if(!query.isEmpty()) {
      QTextCursor cursor(sourceView_->document());
      while(true) { cursor=sourceView_->document()->find(query,cursor); if(cursor.isNull())break;sourceMatches_.append(cursor); }
    }
    if(resetIndex||queryChanged)sourceSearchIndex_=sourceMatches_.isEmpty()?-1:0;
    if(sourceSearchIndex_>=sourceMatches_.size())sourceSearchIndex_=sourceMatches_.isEmpty()?-1:0;
    QList<QTextEdit::ExtraSelection> selections;
    for(int i=0;i<sourceMatches_.size();++i) {
      if (i >= 1000 && i != sourceSearchIndex_) continue;
      QTextEdit::ExtraSelection selected;selected.cursor=sourceMatches_[i];
      selected.format.setBackground(i==sourceSearchIndex_?theme::searchCurrentBg():theme::hit());
      selected.format.setForeground(i==sourceSearchIndex_?theme::searchCurrentText():theme::text());
      selections.append(selected);
    }
    sourceView_->setExtraSelections(selections);
    search_->setCounter(sourceSearchIndex_+1,sourceMatches_.size());
    if((resetIndex||queryChanged)&&sourceSearchIndex_>=0) {sourceView_->setTextCursor(sourceMatches_[sourceSearchIndex_]);sourceView_->ensureCursorVisible();}
  }
  positionSearchPanel();
}

void MainWindow::showSourceMatch(int index) {
  if(sourceMatches_.isEmpty())return;
  sourceSearchIndex_=(index%sourceMatches_.size()+sourceMatches_.size())%sourceMatches_.size();
  sourceView_->setTextCursor(sourceMatches_[sourceSearchIndex_]);
  sourceView_->ensureCursorVisible();
  refreshSearch(false);
}

void MainWindow::runSearch(bool forward) { showSourceMatch(sourceSearchIndex_+(forward?1:-1)); }

void MainWindow::replaceCurrent() {
  if (modalOpen_ || busy_ || isAsyncBusy() || compositionActive() || search_->query().trimmed().isEmpty()) return;
  int changed = 0;
  if (documentMode_) {
    changed = documentView_->replaceCurrent(search_->replacement()) ? 1 : 0;
  } else {
    refreshSearch(false);
    if (sourceSearchIndex_ < 0 || sourceSearchIndex_ >= sourceMatches_.size()) return;
    QTextCursor cursor = sourceMatches_[sourceSearchIndex_];
    const int start = cursor.selectionStart();
    const int oldLength = cursor.selectionEnd() - start;
    const int nextOriginal = sourceSearchIndex_ + 1 < sourceMatches_.size()
        ? sourceMatches_[sourceSearchIndex_ + 1].selectionStart() : -1;
    int delta = 0;
    if (cursor.selectedText() != search_->replacement()) {
      cursor.beginEditBlock();
      cursor.insertText(search_->replacement());
      cursor.endEditBlock();
      delta = cursor.position() - start - oldLength;
      sourceView_->setTextCursor(cursor);
      changed = 1;
    }
    refreshSearch(false);
    sourceSearchIndex_ = -1;
    if (nextOriginal >= 0) {
      for (int i = 0; i < sourceMatches_.size(); ++i) {
        if (sourceMatches_[i].selectionStart() == nextOriginal + delta) {
          sourceSearchIndex_ = i;
          break;
        }
      }
    }
    if (sourceSearchIndex_ >= 0) showSourceMatch(sourceSearchIndex_);
  }
  collectDraft(false);
  refreshSearch(false);
  search_->setFeedback(changed ? QStringLiteral("已替换 %1 处").arg(changed) : QStringLiteral("内容未变化"));
}

void MainWindow::replaceAll() {
  if (modalOpen_ || busy_ || isAsyncBusy() || compositionActive() || search_->query().trimmed().isEmpty() || !collectDraft()) return;
  refreshSearch(false);
  const QString replacement = search_->replacement();
  int count = 0;
  if (documentMode_) count = documentView_->replacementChangeCount(replacement);
  else for (const QTextCursor& match : sourceMatches_) if (match.selectedText() != replacement) ++count;
  if (count == 0) { search_->setFeedback(QStringLiteral("内容未变化")); return; }
  const quint64 expectedSession = session_;
  const QString expectedContent = draftMarkdown_;
  const QString query = search_->query();
  const bool expectedMode = documentMode_;
  if (ask(QStringLiteral("全部替换"), QStringLiteral("将替换当前文档的 %1 处内容。").arg(count),
          QStringLiteral("全部替换"), QStringLiteral("取消")) != 2) return;
  if (session_ != expectedSession || documentMode_ != expectedMode || query != search_->query() ||
      replacement != search_->replacement() || !collectDraft() || draftMarkdown_ != expectedContent) return;
  if (documentMode_) count = documentView_->replaceAll(replacement);
  else {
    QTextCursor group(sourceView_->document());
    group.beginEditBlock();
    for (int i = sourceMatches_.size() - 1; i >= 0; --i) {
      QTextCursor cursor = sourceMatches_[i];
      if (cursor.selectedText() != replacement) cursor.insertText(replacement);
    }
    group.endEditBlock();
  }
  collectDraft(false);
  refreshSearch(true);
  search_->setFeedback(count ? QStringLiteral("已替换 %1 处").arg(count) : QStringLiteral("内容未变化"));
}
void MainWindow::closeSearch() {
  search_->closePanel();toolbar_->setSearchChecked(false);
  documentView_->setSearchQuery(QString(),false);
  sourceView_->setExtraSelections({});
  if(!applying_) {if(documentMode_)documentView_->setFocus();else sourceView_->setFocus();}
}

void MainWindow::layoutSidebar() {
  if (!body_ || !side_ || !bodyLayout_) return;
  // The original outline rule: below 1024 px the sidebar floats over the
  // document, and switching between docked and floating keeps it open or shut.
  const bool floating = width() < 1024;
  if (floating != sideFloating_) {
    const bool wasVisible = !side_->isHidden();
    sideFloating_ = floating;
    if (floating) bodyLayout_->removeWidget(side_);
    else bodyLayout_->insertWidget(0, side_);
    side_->setFloating(floating);
    side_->setVisible(wasVisible);
    bodyLayout_->activate();
  }
  if (floating) {
    side_->setGeometry(12, 8, qMin(248, qMax(0, body_->width() - 24)), qMax(0, body_->height() - 16));
    if (side_->isVisible()) side_->raise();
  }
}

void MainWindow::setSidebarVisible(bool visible, bool remember) {
  if (remember) sidePreferred_ = visible;
  toolbar_->setSidebarChecked(visible);
  if (side_->isHidden() == !visible) {
    if (remember) saveWorkspace();
    return;
  }
  if (!visible && side_->isAncestorOf(QApplication::focusWidget())) {
    if (documentMode_) documentView_->setFocus();
    else sourceView_->setFocus();
  }
  side_->setVisible(visible);
  if (visible) {
    layoutSidebar();
    if (sideFloating_) {
      side_->raise();
      side_->focusCurrent();
    }
    sidebarShown();
  }
  positionSearchPanel();
  if (remember) saveWorkspace();
}

void MainWindow::sidebarShown() {
  // The outline is only kept current while it is on screen.
  if (applying_ || !outline_->isVisible()) return;
  collectDraft(false);
  refreshOutlineForDraft();
  updateActiveHeading();
}

void MainWindow::toggleSidebar() {
  if (modalOpen_) return;
  setSidebarVisible(side_->isHidden(), true);
}

void MainWindow::showFiles(bool focus) {
  if (modalOpen_) return;
  side_->setCurrentTab(SidePanel::Files);
  setSidebarVisible(true, true);
  if (focus) fileTree_->focusTree();
}

void MainWindow::openFolder(const QString& path) {
  const QFileInfo info(path);
  if (path.isEmpty() || !info.isDir()) return;
  fileTree_->setRootPath(info.absoluteFilePath());
  showFiles(false);
  saveWorkspace();
}

void MainWindow::chooseFolder() {
  if (modalOpen_) return;
  QString folder;
  {
    QScopedValueRollback<bool> modal(modalOpen_, true);
    QString start = fileTree_->rootPath();
    if (start.isEmpty() && !documentPath_.isEmpty())
      start = QFileInfo(FileTreePanel::normalizedPath(documentPath_)).absolutePath();
    folder = QFileDialog::getExistingDirectory(this, QStringLiteral("打开文件夹"), start);
  }
  if (!folder.isEmpty()) openFolder(folder);
}

void MainWindow::openFromTree(const QString& path) {
  if (path.isEmpty()) return;
  if (sideFloating_) setSidebarVisible(false, false);
  if (!documentPath_.isEmpty() && FileTreePanel::samePath(path, documentPath_)) return;
  openPath(path, false, true);
}

void MainWindow::renameFromTree(const QString& path, const QString& newName) {
  pendingRenames_.append({path, newName});
  // Called from inside the rename field's key or focus handling: rename now if
  // nothing is busy, but leave any dialog until that input event has finished.
  runTreeWork(false);
}

void MainWindow::runTreeWork(bool showErrors) {
  // A dialog, save, open or IME composition owns the session path right now.
  // Keep the names the user typed and retry when that work ends.
  while (!pendingRenames_.isEmpty() && !modalOpen_ && !busy_ && !isAsyncBusy() && !compositionActive()) {
    const PendingRename next = pendingRenames_.takeFirst();
    const QJsonObject result = renameEntry(next.path, next.name);
    if (!result.value("ok").toBool()) pendingErrors_ << result.value("message").toString();
  }
  // ask() refuses to stack dialogs, so an error waits for any open one to close.
  if (showErrors) {
    while (!pendingErrors_.isEmpty() && !modalOpen_) showError(pendingErrors_.takeFirst());
    // A deletion asks first, so it runs outside the key or menu event that
    // requested it, after the renames and errors queued before it.
    if (!pendingDelete_.isEmpty() && pendingRenames_.isEmpty() && pendingErrors_.isEmpty() && !modalOpen_ &&
        !busy_ && !isAsyncBusy() && !compositionActive()) {
      deleteEntry(std::exchange(pendingDelete_, QString()));
    }
    if (!pendingMovePath_.isEmpty() && pendingRenames_.isEmpty() && pendingErrors_.isEmpty() &&
        pendingDelete_.isEmpty() && !modalOpen_ && !busy_ && !isAsyncBusy() && !compositionActive()) {
      const QString directory = std::exchange(pendingMoveDirectory_, QString());
      moveEntry(std::exchange(pendingMovePath_, QString()), directory);
    }
  }
  if (pendingRenames_.isEmpty() && pendingErrors_.isEmpty() && pendingDelete_.isEmpty() &&
      pendingMovePath_.isEmpty()) {
    treeWorkTimer_.stop();
  } else if (!showErrors) {
    QTimer::singleShot(0, this, [this] { runTreeWork(true); });
  } else if (!treeWorkTimer_.isActive()) {
    treeWorkTimer_.start();
  }
}

void MainWindow::discardFreshFiles(bool keepCurrent) {
  QStringList kept;
  for (const QString& fresh : std::as_const(freshFiles_)) {
    if (keepCurrent && FileTreePanel::samePath(fresh, documentPath_)) {
      kept << fresh;
      continue;
    }
    // The core removes it only while it is still an empty regular file.
    bridge::removeEmptyMarkdown(fresh);
  }
  freshFiles_ = kept;
}

void MainWindow::moveFromTree(const QString& path, const QString& directory) {
  if (path.isEmpty() || directory.isEmpty()) return;
  pendingMovePath_ = path;
  pendingMoveDirectory_ = directory;
  QTimer::singleShot(0, this, [this] { runTreeWork(true); });
}

void MainWindow::moveEntry(const QString& path, const QString& directory) {
  // The warning counts links in the latest typing too.
  if (!collectDraft()) return;
  const QString draft = currentMarkdown();
  const QJsonObject target = bridge::inspectMove(path, directory, documentPath_.isEmpty() ? nullptr : &draft);
  if (!target.value("ok").toBool()) {
    showError(target.value("message").toString());
    return;
  }
  if (target.value("sameFolder").toBool()) return;
  const bool folder = target.value("isDir").toBool();
  const int links = target.value("relativeReferences").toInt();
  // A folder moves together with what it links to inside it, so only files warn.
  if (!folder && links > 0) {
    QStringList examples;
    for (const auto& value : target.value("examples").toArray()) examples << value.toString();
    const QString destination =
        QFileInfo(QFileInfo(FileTreePanel::normalizedPath(target.value("target").toString())).absolutePath()).fileName();
    const QString message =
        QStringLiteral("“%1”里有 %2 处用相对路径写的图片或链接，例如 %3。移到“%4”后，它们可能找不到。\n\n要继续移动吗？")
            .arg(target.value("name").toString())
            .arg(links)
            .arg(examples.join(QStringLiteral("、")), destination);
    if (ask(QStringLiteral("移动文件"), message, QStringLiteral("仍然移动"), QStringLiteral("取消")) != 2) return;
  }
  // Windows refuses to move a folder the file panel is watching.
  if (folder) fileTree_->suspendWatching();
  const QJsonObject result = bridge::moveEntry(path, directory);
  const bool moved = result.value("ok").toBool();
  if (folder) fileTree_->resumeWatching(moved ? path : QString(), moved ? result.value("path").toString() : QString());
  if (!moved) {
    showError(result.value("message").toString());
    return;
  }
  // A new file the user moved is theirs to keep, as after a rename.
  freshFiles_.removeIf([&](const QString& fresh) {
    return FileTreePanel::samePath(fresh, path) || FileTreePanel::isInside(fresh, path) ||
           FileTreePanel::samePath(fresh, target.value("path").toString()) ||
           FileTreePanel::isInside(fresh, target.value("path").toString());
  });
  const QString sessionPath = result.value("sessionPath").toString();
  if (sessionPath.isEmpty() || documentPath_.isEmpty()) return;
  // Only the identity changes, as after a rename: the view is not rebuilt.
  documentPath_ = sessionPath;
  documentView_->setDocumentPath(sessionPath);
  refreshIdentity();
  fileTree_->revealFile(sessionPath);
}

void MainWindow::deleteFromTree(const QString& path) {
  if (path.isEmpty()) return;
  // A newer request replaces one that is still waiting.
  pendingDelete_ = path;
  QTimer::singleShot(0, this, [this] { runTreeWork(true); });
}

void MainWindow::deleteEntry(const QString& path) {
  // dirty_ must include the latest typing before the prompt mentions it.
  if (!collectDraft()) return;
  const QJsonObject target = bridge::inspectDelete(path);
  if (!target.value("ok").toBool()) {
    showError(target.value("message").toString());
    return;
  }
  const QString name = target.value("name").toString();
  const bool folder = target.value("isDir").toBool();
  const bool closes = target.value("containsSession").toBool() && !documentPath_.isEmpty();
  const bool unsaved = closes && dirty_;
  QString message = folder
      ? QStringLiteral("要把文件夹“%1”及其中的全部内容移到回收站吗？文件列表里不显示的其他文件（例如图片）也会一起删除。").arg(name)
      : QStringLiteral("要把“%1”移到回收站吗？").arg(name);
  message += QStringLiteral("之后可以从回收站还原。");
  if (unsaved) message += QStringLiteral("\n\n当前文档有未保存的更改，删除后这些更改会丢失。");
  else if (closes) message += QStringLiteral("\n\n当前打开的文档会被关闭。");
  const QString title = folder ? QStringLiteral("删除文件夹") : QStringLiteral("删除文件");
  const QString primary = unsaved ? QStringLiteral("放弃更改并删除") : QStringLiteral("删除");
  if (ask(title, message, primary, QStringLiteral("取消"), true) != 2) return;
  QJsonObject result = removeEntry(path, false);
  if (!result.value("ok").toBool() && result.value("code").toString() == QStringLiteral("RECYCLE_UNAVAILABLE")) {
    const QString again = QStringLiteral("“%1”所在的位置不支持回收站，或者内容太大，回收站放不下。\n\n"
                                         "要永久删除吗？永久删除后无法恢复。").arg(name);
    if (ask(QStringLiteral("无法移到回收站"), again, QStringLiteral("永久删除"), QStringLiteral("取消"), true) != 2) {
      return;
    }
    result = removeEntry(path, true);
  }
  if (!result.value("ok").toBool()) showError(result.value("message").toString());
}

QJsonObject MainWindow::removeEntry(const QString& path, bool permanent) {
  QJsonObject result;
  {
    // The shell may dispatch window messages while it works. Nothing may save,
    // open or prompt meanwhile: the core holds the session lock.
    QScopedValueRollback<bool> modal(modalOpen_, true);
    // Windows refuses to delete a folder the file panel is watching.
    const bool folder = QFileInfo(path).isDir();
    if (folder) fileTree_->suspendWatching();
    result = bridge::deleteEntry(path, permanent);
    if (folder) fileTree_->resumeWatching();
  }
  if (!result.value("ok").toBool()) return result;
  const QString removed = result.value("path").toString();
  freshFiles_.removeIf([&](const QString& fresh) {
    return FileTreePanel::samePath(fresh, path) || FileTreePanel::isInside(fresh, path) ||
           FileTreePanel::samePath(fresh, removed) || FileTreePanel::isInside(fresh, removed);
  });
  if (result.value("closedSession").toBool()) closeDeletedDocument();
  return result;
}

void MainWindow::closeDeletedDocument() {
  // The core already closed the session; only the view is left to reset.
  QScopedValueRollback<bool> applying(applying_, true);
  dirtyTimer_.stop();
  maximumDirtyTimer_.stop();
  ++session_;
  compositionActions_.clear();
  documentPath_.clear();
  documentName_.clear();
  savedMarkdown_.clear();
  draftMarkdown_.clear();
  documentBaselineMarkdown_.clear();
  documentViewMarkdown_.clear();
  sourceBaselineMarkdown_.clear();
  lineEnding_ = QStringLiteral("\n");
  dirty_ = false;
  savedFeedback_ = false;
  failure_.clear();
  documentMode_ = true;
  sourceVisited_ = false;
  sourceScroll_ = documentScroll_ = sourceSelectionStart_ = sourceSelectionEnd_ = 0;
  documentView_->setEmptyState();
  sourceView_->setMarkdown(QString());
  toolbar_->setMode(kModeDocument);
  stack_->setCurrentWidget(documentView_);
  closeSearch();
  for (auto* field : search_->findChildren<QLineEdit*>()) field->clear();
  searchQuery_.clear();
  sourceMatches_.clear();
  sourceSearchIndex_ = -1;
  refreshOutline(QJsonObject());
  refreshIdentity();
}

void MainWindow::createFileIn(const QString& directory) {
  if (directory.isEmpty() || isAsyncBusy()) return;
  const quint64 request = ++openRequestId_;
  afterComposition([this, directory, request] {
    pendingOpenPath_.clear();
    pendingOpenTimer_.stop();
    // Ask before anything touches the disk: a declined switch leaves no file.
    if (!confirmSwitch() || request != openRequestId_) return;
    const QJsonObject result = bridge::createMarkdown(directory, QString());
    if (!result.value("ok").toBool()) {
      showError(result.value("message").toString());
      return;
    }
    const QString path = result.value("path").toString();
    const QString real = result.value("realPath").toString(path);
    // Removed again if it is left empty: switched away from, not opened, or closed.
    freshFiles_ << real;
    pendingTreeRename_ = path;
    pendingTreeRenameReal_ = real;
    // The switch was confirmed above, so open it directly, as chooseFile() does.
    startOpen([path] { return bridge::openDocument(path); }, false);
  });
}

void MainWindow::restoreWorkspace() {
  settingsEnabled_ = true;
  const auto settings = app_settings::open();
  // Without the window size the sidebar would never be wide enough to dock.
  restoreGeometry(settings->value(QStringLiteral("window/geometry")).toByteArray());
  const QString folder = app_settings::loadFolder(*settings, QStringLiteral("sidebar/root"));
  if (!folder.isEmpty() && QFileInfo(folder).isDir()) fileTree_->setRootPath(folder);
  side_->setCurrentTab(settings->value(QStringLiteral("sidebar/tab")).toString() == QStringLiteral("outline")
                           ? SidePanel::Outline
                           : SidePanel::Files);
  sidePreferred_ = settings->value(QStringLiteral("sidebar/visible"), false).toBool();
  layoutSidebar();
  // Decided in showEvent(), once a maximised window has its real width. A
  // remembered sidebar opens only where it docks, never over the document.
  restoreSidebarPending_ = sidePreferred_;
}

void MainWindow::saveWorkspace() {
  if (!settingsEnabled_) return;
  const auto settings = app_settings::open();
  settings->setValue(QStringLiteral("window/geometry"), saveGeometry());
  app_settings::saveFolder(*settings, QStringLiteral("sidebar/root"), fileTree_->rootPath());
  settings->setValue(QStringLiteral("sidebar/visible"), sidePreferred_);
  settings->setValue(QStringLiteral("sidebar/tab"), side_->preferredTab() == SidePanel::Outline
                                                        ? QStringLiteral("outline")
                                                        : QStringLiteral("files"));
}

void MainWindow::positionSearchPanel() {
  if(!search_->isVisible())return;
  search_->setMaximumWidth(qMax(200,content_->width()-32));
  search_->move(qMax(8,content_->width()-search_->width()-16),8);search_->raise();
  avoidSearchPanel();
}

void MainWindow::avoidSearchPanel() {
  if (!search_->isVisible()) return;
  auto* viewport = documentMode_ ? documentView_->viewport() : sourceView_->viewport();
  const QRect panel(viewport->mapFromGlobal(search_->mapToGlobal(QPoint())), search_->size());
  const auto matches = documentMode_ ? documentView_->activeSearchMatchRects()
                                     : sourceView_->activeSearchMatchRects();
  bool overlaps = false;
  qreal top = std::numeric_limits<qreal>::max();
  for (const auto& rect : matches) {
    overlaps = overlaps || rect.intersects(panel);
    top = qMin(top, rect.top());
  }
  if (!overlaps) return;
  const int pixels = qCeil(panel.bottom() + 9 - top);
  if (documentMode_)
    documentView_->verticalScrollBar()->setValue(documentView_->scrollValue() - pixels);
  else sourceView_->scrollSearchMatchDown(pixels);
}

bool MainWindow::eventFilter(QObject* watched,QEvent* event) {
  QWidget* widget=qobject_cast<QWidget*>(watched);
  if (widget == search_ && (event->type() == QEvent::Show || event->type() == QEvent::Resize)) {
    QTimer::singleShot(0, this, [this] { avoidSearchPanel(); });
  }
  if ((widget == documentView_->viewport() || widget == sourceView_->viewport()) && event->type() == QEvent::Resize) {
    QTimer::singleShot(0, this, [this] { avoidSearchPanel(); });
  }
  if ((widget == body_ || widget == content_) && event->type() == QEvent::Resize) {
    QTimer::singleShot(0, this, [this] { layoutSidebar(); positionSearchPanel(); });
  }
  if(widget && widget->window()==this && event->type()==QEvent::KeyPress) {
    auto* key=static_cast<QKeyEvent*>(event);
    if(modalOpen_)return false;
    if(compositionActive()&&(key->key()==Qt::Key_Escape||key->key()==Qt::Key_Return))return false;
    if(key->matches(QKeySequence::Open)||key->matches(QKeySequence::Save)||key->matches(QKeySequence::Find)||
       (key->modifiers()==Qt::ControlModifier&&key->key()==Qt::Key_H)||key->key()==Qt::Key_F6||
       (key->modifiers()==(Qt::ControlModifier|Qt::ShiftModifier)&&key->key()==Qt::Key_E)||
       (key->modifiers()==Qt::ControlModifier&&key->key()==Qt::Key_Backslash)) {
      keyPressEvent(key);return true;
    }
    // Esc in the rename field only cancels the rename. A docked sidebar stays.
    if(key->key()==Qt::Key_Escape && !search_->isAncestorOf(widget) && widget!=fileTree_->renameEditor() &&
       (search_->isVisible()||(sideFloating_&&side_->isVisible()))) {
      keyPressEvent(key);return true;
    }
  }
  if(widget&&widget->window()==this&&event->type()==QEvent::MouseButtonPress&&sideFloating_&&side_->isVisible()&&!modalOpen_&&
      !side_->isAncestorOf(widget)&&widget!=side_&&!toolbar_->isAncestorOf(widget)) {
    setSidebarVisible(false,false);
  }
  return QMainWindow::eventFilter(watched,event);
}

void MainWindow::keyPressEvent(QKeyEvent* event) {
  if(modalOpen_){event->ignore();return;}
  if(event->key()==Qt::Key_Escape){if(compositionActive())return;if(search_->isVisible())closeSearch();else if(sideFloating_&&side_->isVisible())setSidebarVisible(false,false);else QMainWindow::keyPressEvent(event);return;}
  if(event->matches(QKeySequence::Open)){chooseFile();return;}
  if(event->matches(QKeySequence::Save)){afterComposition([this]{save();});return;}
  if(event->matches(QKeySequence::Find)){openSearchPanel(false);return;}
  if(event->modifiers()==Qt::ControlModifier&&event->key()==Qt::Key_H){openSearchPanel(true);return;}
  if(event->modifiers()==(Qt::ControlModifier|Qt::ShiftModifier)&&event->key()==Qt::Key_E){showFiles(true);return;}
  if(event->modifiers()==Qt::ControlModifier&&event->key()==Qt::Key_Backslash){toggleSidebar();return;}
  if(event->key()==Qt::Key_F6){setMode(documentMode_?kModeSource:kModeDocument);return;}
  QMainWindow::keyPressEvent(event);
}

void MainWindow::closeEvent(QCloseEvent* event) {
  if(modalOpen_||busy_||isAsyncBusy()){event->ignore();return;}
  if(compositionActive()) {
    event->ignore();
    if(!deferredClose_){deferredClose_=true;afterComposition([this]{deferredClose_=false;close();});}
    return;
  }
  if(!collectDraft()){event->ignore();return;}
  if(dirty_) {
    const int answer=ask(QStringLiteral("未保存更改"),QStringLiteral("当前文档有未保存更改。"),
        QStringLiteral("保存并退出"),QStringLiteral("继续编辑"),false,QStringLiteral("不保存并退出"));
    if(answer==2){if(!save()){event->ignore();return;}}
    else if(answer!=3){event->ignore();return;}
  }
  saveWorkspace();
  discardFreshFiles(false);
  event->accept();
}

void MainWindow::dragEnterEvent(QDragEnterEvent* event) {
  for(const auto& url:event->mimeData()->urls()) {
    const QString path=url.toLocalFile();
    if(url.isLocalFile()&&QFileInfo(path).isDir()){event->acceptProposedAction();return;}
    if(url.isLocalFile()&&(path.endsWith(".md",Qt::CaseInsensitive)||path.endsWith(".markdown",Qt::CaseInsensitive))){event->acceptProposedAction();return;}
  }
}

void MainWindow::dropEvent(QDropEvent* event) {
  for(const auto& url:event->mimeData()->urls()) {
    const QString path=url.toLocalFile();
    if(url.isLocalFile()&&QFileInfo(path).isDir()){openFolder(path);event->acceptProposedAction();return;}
    if(url.isLocalFile()&&(path.endsWith(".md",Qt::CaseInsensitive)||path.endsWith(".markdown",Qt::CaseInsensitive))){openPath(path);event->acceptProposedAction();return;}
  }
}

void MainWindow::resizeEvent(QResizeEvent* event) {
  QMainWindow::resizeEvent(event);
  layoutSidebar();
  positionSearchPanel();
}

void MainWindow::showEvent(QShowEvent* event) {
  QMainWindow::showEvent(event);
  syncWindowFrameTheme();
  if (restoreSidebarPending_) {
    // Restored geometry, maximised state included, is applied by now.
    QTimer::singleShot(0, this, [this] {
      if (!std::exchange(restoreSidebarPending_, false)) return;
      layoutSidebar();
      if (sidePreferred_ && !sideFloating_) setSidebarVisible(true, false);
    });
  }
}

void MainWindow::applyTheme() {
  setStyleSheet(QStringLiteral("QMainWindow { background: %1; }").arg(theme::bg().name()));
  syncWindowFrameTheme();
  if (!documentMode_ && search_ && search_->isVisible()) {
    refreshSearch(false);
  }
  update();
}

void MainWindow::syncWindowFrameTheme() {
#ifdef Q_OS_WIN
  if (!testAttribute(Qt::WA_WState_Created) ||
      QGuiApplication::platformName() != QStringLiteral("windows")) {
    return;
  }
  const WId id = internalWinId();
  if (!id) return;
  using DwmSetWindowAttributeFn = HRESULT(WINAPI*)(HWND, DWORD, LPCVOID, DWORD);
  static const DwmSetWindowAttributeFn setAttr = []() -> DwmSetWindowAttributeFn {
    HMODULE module = GetModuleHandleW(L"dwmapi.dll");
    if (!module) module = LoadLibraryW(L"dwmapi.dll");
    if (!module) return nullptr;
    return reinterpret_cast<DwmSetWindowAttributeFn>(
        GetProcAddress(module, "DwmSetWindowAttribute"));
  }();
  if (!setAttr) return;
  const BOOL dark = theme::isDark() ? TRUE : FALSE;
  const HWND hwnd = reinterpret_cast<HWND>(id);
  constexpr DWORD kDwmwaUseImmersiveDarkMode = 20;
  constexpr DWORD kDwmwaUseImmersiveDarkModeLegacy = 19;
  if (FAILED(setAttr(hwnd, kDwmwaUseImmersiveDarkMode, &dark, sizeof(dark)))) {
    setAttr(hwnd, kDwmwaUseImmersiveDarkModeLegacy, &dark, sizeof(dark));
  }
#endif
}
