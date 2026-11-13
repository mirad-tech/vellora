#include "source_view.h"

#include <QFontMetricsF>
#include <QPalette>
#include <QInputMethodEvent>
#include <QKeyEvent>
#include <QSignalBlocker>
#include <QScrollBar>

#include <QTextBlock>
#include <QTextLayout>
#include <QTimer>

#include "theme.h"

namespace {
// QPlainTextDocumentLayout ignores QTextBlockFormat::lineHeight. Keep the
// native plain-text editor (IME, undo, selection) while assigning CSS line boxes.
class SourceDocumentLayout final : public QPlainTextDocumentLayout {
 public:
  explicit SourceDocumentLayout(QTextDocument* document) : QPlainTextDocumentLayout(document) {}
  QRectF blockBoundingRect(const QTextBlock& block) const override {
    QRectF bounds = QPlainTextDocumentLayout::blockBoundingRect(block);
    if (!block.isVisible()) return bounds;
    QTextLayout* layout = block.layout();
    for (int index = 0; index < layout->lineCount(); ++index) {
      QTextLine line = layout->lineAt(index);
      line.setPosition(QPointF(line.x(), index * 23.8 + (23.8 - line.height()) / 2));
    }
    bounds.setHeight(qMax(1, layout->lineCount()) * 23.8);
    return bounds;
  }
};
}  // namespace

SourceView::SourceView(QWidget* parent) : QPlainTextEdit(parent) {
  document()->setDocumentLayout(new SourceDocumentLayout(document()));
  setFrameShape(QFrame::NoFrame);
  setLineWrapMode(QPlainTextEdit::WidgetWidth);
  setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  // tab-size: 2 in the stylesheet; the tab stop follows the mono advance.
  setTabStopDistance(QFontMetricsF(theme::monoFont(14)).horizontalAdvance(QLatin1Char(' ')) * 2);
  setStyleSheet(QStringLiteral(
                    "QPlainTextEdit { background: %1; color: %2; border: 0;"
                    "  font-family: 'Cascadia Code', 'Consolas', 'Microsoft YaHei UI';"
                    "  font-size: 14px; }"
                    "QScrollBar:vertical { width: 10px; background: transparent; margin: 0; border: 0; }"
                    "QScrollBar::handle:vertical { background: rgba(11,11,11,0.20); border-radius: 2px; margin: 0 1px 0 5px; min-height: 32px; }"
                    "QScrollBar::handle:vertical:hover { background: rgba(11,11,11,0.35); }"
                    "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }"
                    "QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }")
                    .arg(theme::surface().name(), theme::text().name()));

  // The legacy source view is a plain textarea plus a search-highlight layer:
  // there is no syntax colouring. Keeping it plain is the 1:1 behaviour.
  document()->setDocumentMargin(0);
  document()->setDefaultFont(theme::monoFont(14));
  QPalette textPalette = theme::selectionPalette(palette());
  textPalette.setColor(QPalette::Text, theme::text());
  setPalette(textPalette);
  connect(this, &QPlainTextEdit::selectionChanged, this, &SourceView::updateSelectionPalette);
  connect(verticalScrollBar(), &QScrollBar::rangeChanged, this, [this] {
    QTimer::singleShot(0, this, [this] { rebuildMargins(); });
  });
  connect(verticalScrollBar(), &QScrollBar::actionTriggered, this, [this] {
    if (verticalScrollBar()->sliderPosition() == 0 && topInset_ != 32) {
      topInset_ = 32;
      rebuildMargins();
    }
  });
  rebuildMargins();
}

void SourceView::setExtraSelections(const QList<QTextEdit::ExtraSelection>& selections) {
  currentSearchMatch_ = QTextCursor();
  for (const auto& selection : selections) {
    if (selection.format.background().color() == theme::searchCurrentBg() &&
        selection.format.foreground().color() == theme::searchCurrentText()) {
      currentSearchMatch_ = selection.cursor;
      break;
    }
  }
  QPlainTextEdit::setExtraSelections(selections);
  updateSelectionPalette();
}

void SourceView::updateSelectionPalette() {
  // Native selection paints over ExtraSelections. Preserve the active search
  // colour only for its exact range; unrelated user selections stay warm neutral.
  const QTextCursor selected = textCursor();
  const bool active = selected.hasSelection() && !currentSearchMatch_.isNull() &&
      selected.document() == currentSearchMatch_.document() &&
      selected.selectionStart() == currentSearchMatch_.selectionStart() &&
      selected.selectionEnd() == currentSearchMatch_.selectionEnd();
  QPalette colours = theme::selectionPalette(palette());
  if (active) {
    for (auto group : {QPalette::Active, QPalette::Inactive, QPalette::Disabled}) {
      colours.setColor(group, QPalette::Highlight, theme::searchCurrentBg());
      colours.setColor(group, QPalette::HighlightedText, theme::searchCurrentText());
    }
  }
  if (colours != palette()) setPalette(colours);
}

void SourceView::rebuildMargins() {
  // Same column model as the reading view: the 800px column is centred in the
  // window. Bottom padding must not shorten the editable viewport itself:
  // the user's source workspace extends to the application's lower edge.
  const int layoutWidth = width() - (verticalScrollBar()->isVisible() ? verticalScrollBar()->width() : 0);
  const int available = qMin(theme::documentMaxWidth(), layoutWidth);
  const bool narrow = window()->width() < 760;
  const int padding = narrow ? 20 : theme::documentPaddingInline();
  const int column = qMax(160, available - padding * 2);
  const int side = qMax(padding, (layoutWidth - column) / 2);
  const QMargins wanted(side, topInset_, side, 0);
  if (wanted == viewportMargins()) return;
  setViewportMargins(wanted.left(), wanted.top(), wanted.right(), wanted.bottom());
}

void SourceView::resizeEvent(QResizeEvent* event) {
  QPlainTextEdit::resizeEvent(event);
  if (!marginPending_) {
    marginPending_ = true;
    QTimer::singleShot(0, this, [this] {
      marginPending_ = false;
      rebuildMargins();
    });
  }
}

void SourceView::setMarkdown(const QString& text) {
  const QSignalBlocker blocker(this);
  topInset_ = 32;
  rebuildMargins();
  setPlainText(text);

  document()->setModified(false);
  verticalScrollBar()->setValue(0);
}

void SourceView::restoreTopInset(int inset) {
  topInset_ = qBound(0, inset, 32);
  rebuildMargins();
}

void SourceView::revealOffset(int offset) {
  topInset_ = 32;
  rebuildMargins();
  QTextCursor target(document());
  target.setPosition(qBound(0, offset, qMax(0, document()->characterCount() - 1)));
  setTextCursor(target);
  ensureCursorVisible();
  // QPlainTextEdit scroll values count visual lines, including soft wraps.
  // Aim 24px below the outer content edge. The fixed top padding may make
  // that position unavailable; use the nearest visible line rather than
  // clipping its caret into the padding. Scrollbar bounds govern EOF/BOF.
  const int desiredY = qMax(0, 24 - viewport()->geometry().top());
  QScrollBar* bar = verticalScrollBar();
  for (int pass = 0; pass < 3; ++pass) {
    const int lines = qRound((cursorRect().top() - desiredY) / 23.8);
    if (lines == 0) break;
    const int before = bar->value();
    bar->setValue(before + lines);
    if (bar->value() == before) break;
  }
  // The native scrollbar advances whole visual lines. Retain its native
  // selection/IME/undo machinery and consume only the remaining top padding
  // for the fractional-line part of the legacy 24px reading anchor. Nothing
  // is inserted into the document. Explicit navigation to BOF restores the
  // full CSS padding, just as scrolling the old outer viewport to zero does.
  if (cursorRect().top() >= 0 && cursorRect().top() <= 24) {
    topInset_ = 24 - cursorRect().top();
    rebuildMargins();
  }
}

void SourceView::keyPressEvent(QKeyEvent* event) {
  if (!composing_ && event->matches(QKeySequence::MoveToStartOfDocument)) {
    topInset_ = 32;
    rebuildMargins();
  }
  QPlainTextEdit::keyPressEvent(event);
}

QString SourceView::selectedText() const {
  const QTextCursor cursor = textCursor();
  if (!cursor.hasSelection()) return QString();
  return cursor.selectedText().replace(QChar(0x2029), '\n');
}

void SourceView::inputMethodEvent(QInputMethodEvent* event) {
  const bool composing = !event->preeditString().isEmpty();
  // Mark composition before the edit emits textChanged, and clear it only
  // after the committed text has reached the document.
  if (composing && !composing_) {
    composing_ = true;
    emit compositionStateChanged(true);
  }
  QPlainTextEdit::inputMethodEvent(event);
  if (!composing && composing_) {
    composing_ = false;
    emit compositionStateChanged(false);
  }
}
