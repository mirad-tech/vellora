#include "main_window.h"

#include <QApplication>
#include <utility>
#include <limits>
#include <QCloseEvent>
#include <QDragEnterEvent>
#include <QFileDialog>
#include <QFileInfo>
#include <QHash>
#include <QUrl>
#include <QHBoxLayout>
#include <QInputMethod>
#include <QKeyEvent>
#include <QLineEdit>
#include <QMimeData>
#include <QRegularExpression>
#include <QScopedValueRollback>
#include <QScrollBar>
#include <QStackedLayout>
#include <QTextBlock>
#include <QVBoxLayout>

#include "bridge.h"
#include "chrome.h"
#include "document_view.h"
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
  setStyleSheet(QStringLiteral("QMainWindow { background: %1; }").arg(theme::bg().name()));
  buildUi();
  dirtyTimer_.setSingleShot(true);
  dirtyTimer_.setInterval(120);
  maximumDirtyTimer_.setSingleShot(true);
  maximumDirtyTimer_.setInterval(500);
  const auto publishDraft = [this] {
    if (applying_ || compositionActive()) return;
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
    if (modalOpen_ || busy_ || compositionActive()) return;
    const QString path = std::exchange(pendingOpenPath_, QString());
    const bool source = pendingOpenSource_;
    pendingOpenTimer_.stop();
    openPath(path, source);
  });
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
  outline_ = new OutlinePanel(body);
  outline_->hide();
  bodyLayout->addWidget(outline_);
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
  connect(toolbar_, &Toolbar::outlineRequested, this, &MainWindow::toggleOutline);
  connect(toolbar_, &Toolbar::modeChanged, this, &MainWindow::setMode);
  connect(documentView_, &DocumentView::openRequested, this, &MainWindow::chooseFile);
  connect(documentView_, &DocumentView::linkActivated, this, &MainWindow::openLink);
  connect(sourceView_, &QPlainTextEdit::textChanged, this, [this] {
    if (applying_ || documentMode_) return;
    failure_.clear();
    savedFeedback_ = false;
    search_->setFeedback(QString());
    draftMarkdown_ = sourceMarkdown();
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
  connect(outline_, &OutlinePanel::closeRequested, this, &MainWindow::toggleOutline);
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
    if (outlineFloating_) { outline_->hide(); toolbar_->setOutlineChecked(false); }
  });
  connect(documentView_->verticalScrollBar(), &QScrollBar::valueChanged, this, [this] { updateActiveHeading(); });
  connect(sourceView_->verticalScrollBar(), &QScrollBar::valueChanged, this, [this] { updateActiveHeading(); });
  refreshIdentity();
}

bool MainWindow::compositionActive() const {
  return (search_ && search_->isComposing()) || (documentMode_ ? documentView_->isComposing() : sourceView_->isComposing());
}

void MainWindow::afterComposition(std::function<void()> action) {
  if (modalOpen_ || busy_) return;
  if (!compositionActive()) { action(); return; }
  const quint64 expectedSession = session_;
  compositionActions_.append([this, expectedSession, action] {
    if (session_ == expectedSession && !modalOpen_ && !busy_) action();
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

void MainWindow::chooseFile() {
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
    opening_ = true;
    refreshIdentity();
    toolbar_->repaint();
    const QJsonObject payload = bridge::openDocument(path);
    opening_ = false;
    if (payload.value("ok").toBool()) applyDocument(payload);
    else showOpenError(payload.value("message").toString());
  });
}

void MainWindow::openPath(const QString& path, bool sourceMode) {
  if (path.isEmpty()) return;
  const quint64 request = ++openRequestId_;
  if (modalOpen_ || busy_) {
    // Match the legacy launch queue: preserve the latest path while a prompt
    // owns the window instead of acknowledging and silently losing the request.
    pendingOpenPath_ = path;
    pendingOpenSource_ = sourceMode;
    pendingOpenTimer_.start();
    return;
  }
  pendingOpenPath_.clear();
  pendingOpenTimer_.stop();
  afterComposition([this, path, sourceMode, request] {
    if (request != openRequestId_ || !confirmDiscard() || request != openRequestId_) return;
    opening_ = true;
    refreshIdentity();
    toolbar_->repaint();
    const QJsonObject payload = bridge::openDocument(path);
    opening_ = false;
    if (!payload.value("ok").toBool()) { showOpenError(payload.value("message").toString()); return; }
    applyDocument(payload);
    if (sourceMode) showSourceMode();
  });
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
  plan_ = payload.value("plan").toObject();
  documentView_->setPlan(plan_, documentPath_);
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
  outline_->hide();
  toolbar_->setOutlineChecked(false);
  refreshOutline(plan_);
  refreshIdentity();
  documentView_->setFocus();
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
  documentView_->setPreviewContext(draftMarkdown_);
  failure_.clear();
  dirty_ = draftMarkdown_ != savedMarkdown_;
  refreshIdentity();
  return true;
}

void MainWindow::setMode(int mode) {
  if (documentPath_.isEmpty() || opening_) return;
  const bool toSource = mode == kModeSource;
  if (toSource == !documentMode_) { toolbar_->setMode(mode); return; }
  toolbar_->setMode(documentMode_ ? kModeDocument : kModeSource);
  afterComposition([this, toSource] {
    if (toSource == !documentMode_ || !collectDraft()) return;
    if (toSource) {
      const QJsonObject anchor = sourceVisited_ ? QJsonObject() : documentView_->readingAnchor();
      documentScroll_ = documentView_->scrollValue();
      const qreal ratio = qreal(documentScroll_) / qMax(1, documentView_->verticalScrollBar()->maximum());
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
      }
      else {
        const QJsonObject parsed = bridge::planFor(draftMarkdown_);
        const int offset = parsed.value("ok").toBool()
            ? sourceOffsetForReadingAnchor(anchor, parsed.value("plan").toObject()) : -1;
        if (offset >= 0) {
          const quint64 expectedSession = session_;
          // Source margins and wrapping finish after the stacked widget is shown.
          QTimer::singleShot(0, this, [this, offset, expectedSession] {
            if (session_ == expectedSession && !documentMode_ && !compositionActive())
              sourceView_->revealOffset(offset);
          });
        } else sourceView_->verticalScrollBar()->setValue(qRound(ratio * sourceView_->verticalScrollBar()->maximum()));
      }
      sourceVisited_ = true;
      sourceView_->setFocus();
    } else {
      sourceScroll_ = sourceView_->verticalScrollBar()->value();
      sourceTopInset_ = sourceView_->topInset();
      sourceSelectionStart_ = sourceView_->textCursor().anchor();
      sourceSelectionEnd_ = sourceView_->textCursor().position();
      if (draftMarkdown_ != documentViewMarkdown_) {
        const auto documentSelection = documentView_->selectionState();
        const QJsonObject result = bridge::planFor(draftMarkdown_);
        if (!result.value("ok").toBool()) { showError(result.value("message").toString()); return; }
        plan_ = result.value("plan").toObject();
        documentBaselineMarkdown_ = draftMarkdown_;
        documentViewMarkdown_ = draftMarkdown_;
        documentView_->setPlan(plan_, documentPath_);
        documentView_->setPreviewContext(draftMarkdown_);
        documentView_->restoreSelectionState(documentSelection);
      }
      documentMode_ = true;
      stack_->setCurrentWidget(documentView_);
      documentView_->setScrollValue(documentScroll_);
      documentView_->setFocus();
    }
    toolbar_->setMode(toSource ? kModeSource : kModeDocument);
    refreshOutlineForDraft();
    if (search_->isVisible()) refreshSearch(true);
    refreshIdentity();
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
  toolbar_->setBusy(busy_ || opening_);
  toolbar_->setSaveEnabled(!documentPath_.isEmpty() && dirty_ && !busy_ && !opening_);
  setWindowTitle(QStringLiteral("Vellora"));
}

void MainWindow::markDirtyIfNeeded() { collectDraft(false); }

bool MainWindow::save(QString conflictToken) {
  if (documentPath_.isEmpty() || modalOpen_ || busy_ || compositionActive() || !collectDraft()) return false;
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
  afterComposition([this, href] {
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
      if (!confirmDiscard()) return;
      const QJsonObject opened = bridge::openLink(documentPath_, href);
      if (opened.value("ok").toBool()) applyDocument(opened);
      else showError(opened.value("message").toString());
    }
  });
}

void MainWindow::refreshOutlineForDraft(bool force) {
  if (documentPath_.isEmpty() || (!force && !outline_->isVisible()) || outlineMarkdown_ == draftMarkdown_) return;
  const QJsonObject result = bridge::planFor(draftMarkdown_);
  if (result.value("ok").toBool()) refreshOutline(result.value("plan").toObject());
}

void MainWindow::refreshOutline(const QJsonObject& plan) {
  outlineMarkdown_ = draftMarkdown_;
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
      selected.format.setBackground(i==sourceSearchIndex_?theme::accent():theme::hit());
      if(i==sourceSearchIndex_)selected.format.setForeground(theme::surface());
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
  if (modalOpen_ || busy_ || compositionActive() || search_->query().trimmed().isEmpty()) return;
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
  if (modalOpen_ || busy_ || compositionActive() || search_->query().trimmed().isEmpty() || !collectDraft()) return;
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

void MainWindow::toggleOutline() {
  if(modalOpen_||documentPath_.isEmpty())return;
  const bool visible=!outline_->isVisible();outline_->setVisible(visible);toolbar_->setOutlineChecked(visible);
  if(visible){layoutOutline();collectDraft(false);refreshOutlineForDraft();updateActiveHeading();}
  positionSearchPanel();
}

void MainWindow::layoutOutline() {
  if (!body_ || !outline_ || !bodyLayout_) return;
  const bool floating = width() < 1024;
  if (floating != outlineFloating_) {
    const bool wasVisible = outline_->isVisible();
    outlineFloating_ = floating;
    if (floating) bodyLayout_->removeWidget(outline_);
    else bodyLayout_->insertWidget(0, outline_);
    outline_->setFloating(floating);
    outline_->setVisible(wasVisible);
    bodyLayout_->activate();
  }
  if (floating) {
    outline_->setGeometry(12, 8, qMin(248, qMax(0, body_->width() - 24)), qMax(0, body_->height() - 16));
    if (outline_->isVisible()) outline_->raise();
  }
}
void MainWindow::positionSearchPanel() {
  if(!search_->isVisible())return;
  search_->setMaximumWidth(qMax(200,content_->width()-32));
  search_->move(qMax(8,content_->width()-search_->width()-16),8);search_->raise();
}

bool MainWindow::eventFilter(QObject* watched,QEvent* event) {
  QWidget* widget=qobject_cast<QWidget*>(watched);
  if ((widget == body_ || widget == content_) && event->type() == QEvent::Resize) {
    QTimer::singleShot(0, this, [this] { layoutOutline(); positionSearchPanel(); });
  }
  if(widget && widget->window()==this && event->type()==QEvent::KeyPress) {
    auto* key=static_cast<QKeyEvent*>(event);
    if(modalOpen_)return false;
    if(compositionActive()&&(key->key()==Qt::Key_Escape||key->key()==Qt::Key_Return))return false;
    if(key->matches(QKeySequence::Open)||key->matches(QKeySequence::Save)||key->matches(QKeySequence::Find)||
       (key->modifiers()==Qt::ControlModifier&&key->key()==Qt::Key_H)||key->key()==Qt::Key_F6) {
      keyPressEvent(key);return true;
    }
    if(key->key()==Qt::Key_Escape && !search_->isAncestorOf(widget) && (search_->isVisible()||outline_->isVisible())) {
      keyPressEvent(key);return true;
    }
  }
  if(widget&&widget->window()==this&&event->type()==QEvent::MouseButtonPress&&outlineFloating_&&outline_->isVisible()&&!modalOpen_&&
      !outline_->isAncestorOf(widget)&&widget!=outline_&&!toolbar_->isAncestorOf(widget)) {
    outline_->hide();toolbar_->setOutlineChecked(false);
  }
  return QMainWindow::eventFilter(watched,event);
}

void MainWindow::keyPressEvent(QKeyEvent* event) {
  if(modalOpen_){event->ignore();return;}
  if(event->key()==Qt::Key_Escape){if(compositionActive())return;if(search_->isVisible())closeSearch();else if(outline_->isVisible())toggleOutline();else QMainWindow::keyPressEvent(event);return;}
  if(event->matches(QKeySequence::Open)){chooseFile();return;}
  if(event->matches(QKeySequence::Save)){afterComposition([this]{save();});return;}
  if(event->matches(QKeySequence::Find)){openSearchPanel(false);return;}
  if(event->modifiers()==Qt::ControlModifier&&event->key()==Qt::Key_H){openSearchPanel(true);return;}
  if(event->key()==Qt::Key_F6){setMode(documentMode_?kModeSource:kModeDocument);return;}
  QMainWindow::keyPressEvent(event);
}

void MainWindow::closeEvent(QCloseEvent* event) {
  if(modalOpen_||busy_){event->ignore();return;}
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
  event->accept();
}

void MainWindow::dragEnterEvent(QDragEnterEvent* event) {
  for(const auto& url:event->mimeData()->urls()) {
    const QString path=url.toLocalFile();
    if(url.isLocalFile()&&(path.endsWith(".md",Qt::CaseInsensitive)||path.endsWith(".markdown",Qt::CaseInsensitive))){event->acceptProposedAction();return;}
  }
}

void MainWindow::dropEvent(QDropEvent* event) {
  for(const auto& url:event->mimeData()->urls()) {
    const QString path=url.toLocalFile();
    if(url.isLocalFile()&&(path.endsWith(".md",Qt::CaseInsensitive)||path.endsWith(".markdown",Qt::CaseInsensitive))){openPath(path);event->acceptProposedAction();return;}
  }
}

void MainWindow::resizeEvent(QResizeEvent* event) {
  QMainWindow::resizeEvent(event);
  layoutOutline();
  positionSearchPanel();
}
