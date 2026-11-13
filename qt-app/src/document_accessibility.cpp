#include "document_accessibility.h"
#include "document_view.h"

#include <QAccessibleWidget>
#include <QAbstractTextDocumentLayout>
#include <QApplication>
#include <QEvent>
#include <QPointer>
#include <QScrollBar>
#include <QTextBoundaryFinder>
#include <QTextDocument>
#include <QTextFragment>
#include <QTextLayout>
#include <QTextTable>
#include <QTimer>
#include <QtMath>

#include <functional>
#include <algorithm>

class DocumentSemanticNode;

namespace {
// Keep document offsets identical to QTextCursor's UTF-16 positions. In
// particular, never expand image/object placeholders into arbitrary-length alt
// text in the text stream, which would invalidate every following position.
QString plain(QString text) {
  text.replace(QChar::ParagraphSeparator, QLatin1Char('\n'));
  text.replace(QChar::LineSeparator, QLatin1Char('\n'));
  text.replace(QChar::Nbsp, QLatin1Char(' '));
  // QTextCursor returns frame delimiters for table boundaries; QTextDocument's
  // plain-text stream represents each one as one newline at the same offset.
  text.replace(QChar(0xfdd0), QLatin1Char('\n'));
  text.replace(QChar(0xfdd1), QLatin1Char('\n'));
  return text;
}

class AccessibilityObserver final : public QObject {
 public:
  explicit AccessibilityObserver(QObject* parent) : QObject(parent) {}
  std::function<void()> schedule;
  bool eventFilter(QObject*, QEvent* event) override {
    switch (event->type()) {
      case QEvent::Paint:
      case QEvent::FocusIn:
      case QEvent::FocusOut:
      case QEvent::KeyPress:
      case QEvent::InputMethod:
      case QEvent::MouseButtonPress:
      case QEvent::MouseButtonRelease:
      case QEvent::MouseMove:
      case QEvent::Show:
      case QEvent::Hide:
      case QEvent::Resize:
      case QEvent::Move:
      case QEvent::EnabledChange:
        if (schedule) schedule();
        break;
      default: break;
    }
    return false;
  }
};
}

// This is deliberately a friend of DocumentView, rather than a second editing
// engine. All edits go through the existing checked, undoable widget operations.
class AccessibleDocumentView final : public QAccessibleWidget,
                                     public QAccessibleTextInterface,
                                     public QAccessibleEditableTextInterface {
 public:
  explicit AccessibleDocumentView(DocumentView* view)
      : QAccessibleWidget(view, QAccessible::EditableText) {
    observer_ = new AccessibilityObserver(view);
    observer_->schedule = [this] { schedule(); };
    view->installEventFilter(observer_);
    view->viewport()->installEventFilter(observer_);
    QObject::connect(view, &DocumentView::viewportChanged, observer_, [this] {
      geometryDirty_ = true;
      schedule();
    });
    attachDocument();
    snapshot_ = view->document_ ? view->document_->toPlainText() : QString();
    lastSelection_ = view->selectionState();
    lastState_ = state();
    // A NameChanged event can construct us before the widget constructor has
    // assigned its document. Defer connecting it until construction completes.
    schedule();
  }

  ~AccessibleDocumentView() override;

  int childCount() const override;
  QAccessibleInterface* child(int index) const override;
  int indexOfChild(const QAccessibleInterface* child) const override;
  QAccessibleInterface* childAt(int x, int y) const override;

  void* interface_cast(QAccessible::InterfaceType type) override {
    if (type == QAccessible::TextInterface) return static_cast<QAccessibleTextInterface*>(this);
    if (type == QAccessible::EditableTextInterface)
      return editable() ? static_cast<QAccessibleEditableTextInterface*>(this) : nullptr;
    return QAccessibleWidget::interface_cast(type);
  }

  QAccessible::State state() const override {
    auto result = QAccessibleWidget::state();
    result.multiLine = true;
    result.selectableText = true;
    result.editable = editable();
    result.readOnly = !result.editable;
    return result;
  }

  QString text(QAccessible::Text type) const override {
    if (type == QAccessible::Value) return text(0, characterCount());
    return QAccessibleWidget::text(type);
  }

  void setText(QAccessible::Text type, const QString& value) override {
    // The document has structural/readonly ranges, so do not let a Value setter
    // bypass the same range validation as the editable-text interface.
    if (type == QAccessible::Value) replaceText(0, characterCount(), value);
  }

  int characterCount() const override {
    const auto* v = view();
    return v && v->document_ ? qMax(0, v->document_->characterCount() - 1) : 0;
  }

  QString text(int start, int end) const override {
    const auto* v = view();
    if (end == -1) end = characterCount();
    if (!v || !v->document_ || start < 0 || end < start || end > characterCount()) return {};
    if (start == 0 && end == characterCount()) return v->document_->toPlainText();
    // Selecting even one table frame delimiter with QTextCursor may expand to
    // a complex selection of the whole table. Read the exact character range
    // instead, in block-sized pieces, without copying the full document for
    // every spoken word or character.
    QString result;
    result.reserve(end - start);
    while (start < end) {
      const auto block = v->document_->findBlock(start);
      const QString content = block.text();
      const int local = start - block.position();
      if (local >= 0 && local < content.size()) {
        const int count = qMin(end - start, int(content.size()) - local);
        result += QStringView(content).mid(local, count);
        start += count;
      } else {
        result += v->document_->characterAt(start);
        ++start;
      }
    }
    return plain(result);
  }

  int cursorPosition() const override {
    const auto* v = view();
    return v && !v->cursor_.isNull() ? v->cursor_.position() : 0;
  }

  int selectionCount() const override {
    const auto* v = view();
    return v && v->cursor_.hasSelection() ? 1 : 0;
  }

  void selection(int index, int* start, int* end) const override {
    if (start) *start = -1;
    if (end) *end = -1;
    const auto* v = view();
    if (index != 0 || !v || !v->cursor_.hasSelection()) return;
    if (start) *start = v->cursor_.selectionStart();
    if (end) *end = v->cursor_.selectionEnd();
  }

  void setCursorPosition(int position) override { setSelection(0, position, position); }
  void addSelection(int start, int end) override { setSelection(0, start, end); }
  void removeSelection(int index) override {
    if (index == 0) setCursorPosition(cursorPosition());
  }

  void setSelection(int index, int start, int end) override {
    auto* v = view();
    if (index != 0 || !v || !v->document_ || v->isComposing() ||
        !validPosition(start) || !validPosition(end)) return;
    v->typingContinuation_ = false;
    v->cursor_ = QTextCursor(v->document_);
    v->cursor_.setPosition(start);
    v->cursor_.setPosition(end, QTextCursor::KeepAnchor);
    v->resetCaretBlink();
    v->ensureCaretVisible();
    synchronize();
  }

  QRect characterRect(int offset) const override {
    const auto* v = view();
    if (!v || !v->document_ || offset < 0 || offset > characterCount()) return {};
    const QTextBlock block = v->document_->findBlock(offset);
    if (!block.isValid() || !block.isVisible() || !block.layout()) return {};
    const auto* layout = block.layout();
    int local = qMin(offset - block.position(), block.length() - 1);
    // Both halves of a surrogate pair occupy the same visual character.
    if (local > 0 && local < block.text().size() && block.text().at(local).isLowSurrogate()) --local;
    const QTextLine line = layout->lineForTextPosition(local);
    if (!line.isValid()) return {};
    const QRectF blockRect = v->document_->documentLayout()->blockBoundingRect(block);
    const qreal first = line.cursorToX(local);
    const int next = layout->nextCursorPosition(local, QTextLayout::SkipCharacters);
    const qreal last = next <= line.textStart() + line.textLength() ? line.cursorToX(next) : first;
    qreal x = blockRect.left() + qMin(first, last);
    // Match DocumentView's code/table horizontal scrolling exactly.
    for (const auto& region : v->horizontalRegions_)
      if (region.node == block.blockFormat().intProperty(QTextFormat::UserProperty + 21)) {
        x -= region.scroll;
        break;
      }
    QRectF rectangle(x + v->contentLeft(),
                     blockRect.top() + line.y() + v->topPadding() - v->scrollValue(),
                     qMax<qreal>(1, qAbs(last - first)), line.height());
    rectangle.translate(v->viewport()->mapToGlobal(QPoint(0, 0)));
    return rectangle.toAlignedRect();
  }

  int offsetAtPoint(const QPoint& point) const override {
    const auto* v = view();
    if (!v || !v->document_) return -1;
    const QPoint local = v->viewport()->mapFromGlobal(point);
    if (!v->viewport()->rect().contains(local)) return -1;
    // A nested raw preview has its own text interface. Do not return an offset
    // from the hidden source behind it.
    if (auto* child = v->viewport()->childAt(local))
      if (child != v->viewport()) return -1;
    const int offset = v->document_->documentLayout()->hitTest(v->hitDocumentPoint(local), Qt::ExactHit);
    return offset >= 0 && offset <= characterCount() ? offset : -1;
  }

  void scrollToSubstring(int start, int end) override {
    auto* v = view();
    if (!v || !v->document_ || start < 0 || end < start || end > characterCount()) return;
    // Scrolling must not change the caret/selection or commit an IME preedit.
    const QTextCursor saved = v->cursor_;
    v->cursor_ = QTextCursor(v->document_);
    v->cursor_.setPosition(start);
    v->ensureCaretVisible();
    const QRect startRect = characterRect(start);
    const QRect endRect = characterRect(end);
    if (!startRect.isEmpty() && !endRect.isEmpty() &&
        endRect.bottom() - startRect.top() < v->viewport()->height() - 96) {
      v->cursor_.setPosition(end);
      v->ensureCaretVisible();
    }
    v->cursor_ = saved;
    geometryDirty_ = true;
    synchronize();
  }

  QString attributes(int offset, int* start, int* end) const override {
    if (start) *start = -1;
    if (end) *end = -1;
    const auto* v = view();
    if (!v || !v->document_ || offset < 0 || offset >= characterCount()) return {};
    const auto block = v->document_->findBlock(offset);
    QTextCharFormat format = block.charFormat();
    int first = block.position(), last = qMin(characterCount(), first + block.length());
    for (auto it = block.begin(); !it.atEnd(); ++it) {
      const auto fragment = it.fragment();
      if (offset >= fragment.position() && offset < fragment.position() + fragment.length()) {
        first = fragment.position(); last = first + fragment.length(); format = fragment.charFormat(); break;
      }
    }
    if (start) *start = first;
    if (end) *end = last;
    const bool writable = canEdit(offset, offset);
    return QStringLiteral("read-only:%1;font-weight:%2;font-style:%3;text-underline-type:%4;")
      .arg(writable ? QStringLiteral("false") : QStringLiteral("true"))
      .arg(format.fontWeight() >= QFont::DemiBold ? 700 : 400)
      .arg(format.fontItalic() ? QStringLiteral("italic") : QStringLiteral("normal"))
      .arg(format.fontUnderline() ? QStringLiteral("single") : QStringLiteral("none"));
  }

  QString textAtOffset(int offset, QAccessible::TextBoundaryType type, int* start, int* end) const override {
    return boundaryText(offset, type, 0, start, end);
  }
  QString textBeforeOffset(int offset, QAccessible::TextBoundaryType type, int* start, int* end) const override {
    return boundaryText(offset, type, -1, start, end);
  }
  QString textAfterOffset(int offset, QAccessible::TextBoundaryType type, int* start, int* end) const override {
    return boundaryText(offset, type, 1, start, end);
  }

  void insertText(int offset, const QString& value) override { replaceText(offset, offset, value); }
  void deleteText(int start, int end) override { replaceText(start, end, QString()); }
  void replaceText(int start, int end, const QString& value) override {
    auto* v = view();
    if (!canEdit(start, end) || (start == end && value.isEmpty())) return;
    v->typingContinuation_ = false;
    v->cursor_ = QTextCursor(v->document_);
    v->cursor_.setPosition(start);
    v->cursor_.setPosition(end, QTextCursor::KeepAnchor);
    if (value.isEmpty()) v->deleteBackward(); else v->insertTyped(value);
    v->typingContinuation_ = false;
    v->refreshAfterEdit();
    synchronize();
  }

 private:
  friend class DocumentSemanticNode;
  void ensureSemantics() const;
  void clearSemantics();
  QRect semanticRect(int start, int end, QTextTable* table = nullptr, int row = -1, int column = -1) const;
  DocumentView* view() const { return qobject_cast<DocumentView*>(object()); }
  bool editable() const {
    const auto* v = view();
    return v && v->document_ && v->isEnabled() && !v->empty_ && !v->readOnly_;
  }
  bool validPosition(int offset) const {
    const auto* v = view();
    if (!v || !v->document_ || offset < 0 || offset > characterCount()) return false;
    return offset == 0 || offset == characterCount() ||
           !(v->document_->characterAt(offset).isLowSurrogate() &&
             v->document_->characterAt(offset - 1).isHighSurrogate());
  }
  bool canEdit(int start, int end) const {
    const auto* v = view();
    if (!editable() || v->isComposing() || end < start || !validPosition(start) || !validPosition(end)) return false;
    const auto first = v->document_->findBlock(start);
    const auto last = v->document_->findBlock(end);
    for (auto block = first; block.isValid(); block = block.next()) {
      if (!v->blockEditable(block) || !block.isVisible()) return false;
      // QTextDocument frame boundaries and raw-preview placeholders are not
      // editable text. Only their actual visible source blocks may be edited.
      if (block.blockFormat().hasProperty(QTextFormat::UserProperty + 28)) return false;
      const int separator = block.position() + block.length() - 1;
      const auto delimiter = v->document_->characterAt(separator);
      if (separator >= start && separator < end &&
          (delimiter == QChar(0xfdd0) || delimiter == QChar(0xfdd1))) return false;
      if (block == last) return true;
    }
    return false;
  }

  QPair<int, int> boundaryRange(int offset, QAccessible::TextBoundaryType type) const {
    const auto* v = view();
    const int count = characterCount();
    if (!v || !v->document_ || offset < 0 || offset > count || count == 0) return {-1, -1};
    if (type == QAccessible::NoBoundary) return {0, count};
    if (offset == count) --offset;
    const QTextBlock block = v->document_->findBlock(offset);
    if (!block.isValid()) return {-1, -1};
    const int first = block.position(), last = qMin(count, first + block.length());
    if (type == QAccessible::ParagraphBoundary) return {first, last};
    if (type == QAccessible::LineBoundary) {
      auto* layout = block.layout();
      if (!layout) return {-1, -1};
      const auto line = layout->lineForTextPosition(offset - first);
      if (!line.isValid()) return {-1, -1};
      const bool finalLine = line.lineNumber() == layout->lineCount() - 1;
      return {first + line.textStart(), finalLine ? last : first + line.textStart() + line.textLength()};
    }
    QTextBoundaryFinder::BoundaryType finderType;
    switch (type) {
      case QAccessible::CharBoundary: finderType = QTextBoundaryFinder::Grapheme; break;
      case QAccessible::WordBoundary: finderType = QTextBoundaryFinder::Word; break;
      case QAccessible::SentenceBoundary: finderType = QTextBoundaryFinder::Sentence; break;
      default: return {-1, -1};
    }
    // Work within one paragraph, not a full-document copy on each spoken word.
    const QString content = text(first, last);
    QTextBoundaryFinder finder(finderType, content);
    finder.setPosition(offset - first);
    int begin = finder.isAtBoundary() ? finder.position() : finder.toPreviousBoundary();
    if (begin < 0) begin = 0;
    finder.setPosition(offset - first);
    int finish = finder.toNextBoundary();
    if (finish < 0) finish = content.size();
    return {first + begin, first + finish};
  }

  QString boundaryText(int offset, QAccessible::TextBoundaryType type, int direction,
                       int* start, int* end) const {
    if (start) *start = -1;
    if (end) *end = -1;
    if (offset == -2) offset = cursorPosition();
    if (offset == -1) offset = characterCount();
    if (offset < 0 || offset > characterCount()) return {};
    auto range = boundaryRange(offset, type);
    if (direction < 0) {
      if (offset == characterCount()) range = boundaryRange(offset, type);
      else if (range.first > 0) range = boundaryRange(range.first - 1, type);
      else return {};
    } else if (direction > 0) {
      if (range.second < characterCount()) range = boundaryRange(range.second, type);
      else return {};
    }
    if (range.first < 0 || range.second <= range.first) return {};
    if (start) *start = range.first;
    if (end) *end = range.second;
    return text(range.first, range.second);
  }

  void attachDocument() {
    auto* v = view();
    if (!v || !v->document_ || observedDocument_ == v->document_) return;
    observedDocument_ = v->document_;
    contentDirty_ = true;
    QObject::connect(v->document_, &QTextDocument::contentsChanged, observer_, [this] {
      contentDirty_ = true;
      semanticsDirty_ = true;
      schedule();
    });
    QObject::connect(v->document_->documentLayout(), &QAbstractTextDocumentLayout::documentSizeChanged,
                     observer_, [this] { semanticsDirty_ = true; schedule(); });
  }

  void schedule() {
    if (queued_ || !observer_) return;
    queued_ = true;
    QTimer::singleShot(0, observer_, [this] { queued_ = false; synchronize(); });
  }

  void synchronize() {
    auto* v = view();
    if (!v || !v->document_ || v->building_) return;
    attachDocument();
    if (semanticsUsed_) ensureSemantics();
    if (contentDirty_) {
      contentDirty_ = false;
      const QString current = v->document_->toPlainText();
      if (snapshot_ != current) {
        int first = 0;
        const int shared = qMin(snapshot_.size(), current.size());
        while (first < shared && snapshot_.at(first) == current.at(first)) ++first;
        if (first > 0 && ((first < snapshot_.size() && snapshot_.at(first).isLowSurrogate()) ||
                          (first < current.size() && current.at(first).isLowSurrogate()))) --first;
        int oldEnd = snapshot_.size(), newEnd = current.size();
        while (oldEnd > first && newEnd > first && snapshot_.at(oldEnd - 1) == current.at(newEnd - 1)) { --oldEnd; --newEnd; }
        if ((oldEnd < snapshot_.size() && snapshot_.at(oldEnd).isLowSurrogate()) ||
            (newEnd < current.size() && current.at(newEnd).isLowSurrogate())) { ++oldEnd; ++newEnd; }
        QAccessibleTextUpdateEvent event(v, first, snapshot_.mid(first, oldEnd - first), current.mid(first, newEnd - first));
        event.setCursorPosition(cursorPosition());
        snapshot_ = current;
        QAccessible::updateAccessibility(&event);
      } else {
        QAccessibleEvent event(v, QAccessible::TextAttributeChanged);
        QAccessible::updateAccessibility(&event);
      }
    }
    const auto currentSelection = v->selectionState();
    if (currentSelection != lastSelection_) {
      const bool selectionChanged = currentSelection.first != currentSelection.second || lastSelection_.first != lastSelection_.second;
      const bool cursorChanged = currentSelection.second != lastSelection_.second;
      lastSelection_ = currentSelection;
      if (selectionChanged) {
        QAccessibleTextSelectionEvent event(v, v->cursor_.hasSelection() ? v->cursor_.selectionStart() : -1,
                                           v->cursor_.hasSelection() ? v->cursor_.selectionEnd() : -1);
        event.setCursorPosition(cursorPosition());
        QAccessible::updateAccessibility(&event);
      }
      if (cursorChanged) {
        QAccessibleTextCursorEvent event(v, cursorPosition());
        QAccessible::updateAccessibility(&event);
      }
    }
    const auto currentState = state();
    QAccessible::State changes;
    changes.readOnly = currentState.readOnly != lastState_.readOnly;
    changes.editable = currentState.editable != lastState_.editable;
    changes.focused = currentState.focused != lastState_.focused;
    changes.disabled = currentState.disabled != lastState_.disabled;
    changes.invisible = currentState.invisible != lastState_.invisible;
    if (changes.readOnly || changes.editable || changes.focused || changes.disabled || changes.invisible) {
      lastState_ = currentState;
      QAccessibleStateChangeEvent event(v, changes);
      QAccessible::updateAccessibility(&event);
      if (changes.focused && currentState.focused) {
        QAccessibleEvent focus(v, QAccessible::Focus);
        QAccessible::updateAccessibility(&focus);
      }
    }
    if (geometryDirty_) {
      geometryDirty_ = false;
      QAccessibleEvent event(v, QAccessible::LocationChanged);
      QAccessible::updateAccessibility(&event);
    }
  }

  QPointer<AccessibilityObserver> observer_;
  QPointer<QTextDocument> observedDocument_;
  QString snapshot_;
  QPair<int, int> lastSelection_;
  QAccessible::State lastState_;
  bool contentDirty_ = false;
  bool geometryDirty_ = false;
  bool queued_ = false;
  mutable QHash<QString, QAccessible::Id> semanticNodes_;
  mutable QVector<QAccessible::Id> semanticRoots_;
  mutable bool semanticsUsed_ = false;
  mutable bool semanticsDirty_ = true;
  mutable bool rebuildingSemantics_ = false;
};

// Virtual descendants are owned by Qt's accessibility registry, not QWidget.
// They describe the real rendered document; editing remains on the root text
// interface, and activation always goes through the existing guarded link path.
class DocumentSemanticNode final : public QAccessibleInterface,
                                   public QAccessibleImageInterface,
                                   public QAccessibleHyperlinkInterface,
                                   public QAccessibleAttributesInterface,
                                   public QAccessibleActionInterface,
                                   public QAccessibleTableInterface,
                                   public QAccessibleTableCellInterface {
 public:
  explicit DocumentSemanticNode(AccessibleDocumentView* owner) : owner_(owner), view_(owner->view()) {}
  ~DocumentSemanticNode() override = default;
  QAccessible::Role kind = QAccessible::NoRole;
  QAccessible::Id parentId = 0;
  QVector<QAccessible::Id> children;
  QPointer<QTextTable> textTable;
  int start = 0, end = 0, level = 0;
  int row = -1, column = -1, rowSpan = 1, columnSpan = 1;
  QString name, description, target, modelShape, scope;
  bool cellHeader = false;
  bool isCell() const { return kind == QAccessible::Cell || kind == QAccessible::ColumnHeader || kind == QAccessible::RowHeader; }
  bool orderedList = false;
  int listNumber = 1, listPosition = 1, listSize = 0;
  bool isList() const { return kind == QAccessible::List || kind == QAccessible::ListItem; }
  QString listMetadata() const {
    return QString::number(level) + "," + QString::number(orderedList) + "," + QString::number(listNumber)
      + "," + QString::number(listPosition) + "," + QString::number(listSize);
  }

  bool isValid() const override { return !view_.isNull(); }
  QObject* object() const override { return nullptr; }
  QWindow* window() const override { return isValid() ? owner_->window() : nullptr; }
  QAccessibleInterface* parent() const override {
    return !isValid() ? nullptr : parentId ? QAccessible::accessibleInterface(parentId) : owner_;
  }
  int childCount() const override { return children.size(); }
  QAccessibleInterface* child(int index) const override {
    return index >= 0 && index < children.size() ? QAccessible::accessibleInterface(children.at(index)) : nullptr;
  }
  int indexOfChild(const QAccessibleInterface* item) const override {
    for (int i = 0; i < children.size(); ++i) if (child(i) == item) return i;
    return -1;
  }
  QAccessibleInterface* childAt(int x, int y) const override {
    for (int i = children.size() - 1; i >= 0; --i) {
      auto* item = child(i);
      if (item && !item->state().invisible && item->rect().contains(x, y)) return item;
    }
    return nullptr;
  }
  QAccessible::Role role() const override { return kind; }
  QString text(QAccessible::Text type) const override {
    if (!isValid()) return {};
    if (type == QAccessible::Name) return name;
    if (type == QAccessible::Description) return description;
    if (type == QAccessible::Value && kind == QAccessible::Link) return target;
    return {};
  }
  void setText(QAccessible::Text, const QString&) override {} // no alternative editing channel
  QRect rect() const override {
    if (!isValid()) return {};
    QRect bounds = owner_->semanticRect(start, end, textTable.data(), row, column);
    // A list owns its nested content, including table frame padding and image
    // bounds, not just the inline glyph extents of the surrounding paragraphs.
    if (isList()) for (auto id : children)
      if (auto* item = QAccessible::accessibleInterface(id)) bounds = bounds.united(item->rect());
    return bounds;
  }
  QAccessible::State state() const override {
    QAccessible::State result;
    if (!isValid()) { result.invalid = true; return result; }
    const auto root = owner_->state();
    result.disabled = root.disabled;
    result.readOnly = true; // semantic objects are descriptive, never surrogate editors
    result.linked = kind == QAccessible::Link;
    result.invisible = root.invisible || rect().isEmpty();
    const QRect viewport(view_->viewport()->mapToGlobal(QPoint()), view_->viewport()->size());
    result.offscreen = !result.invisible && !viewport.intersects(rect());
    return result;
  }
  void* interface_cast(QAccessible::InterfaceType type) override {
    if (type == QAccessible::ImageInterface && kind == QAccessible::Graphic) return static_cast<QAccessibleImageInterface*>(this);
    if (type == QAccessible::HyperlinkInterface && kind == QAccessible::Link) return static_cast<QAccessibleHyperlinkInterface*>(this);
    if (type == QAccessible::ActionInterface && kind == QAccessible::Link) return static_cast<QAccessibleActionInterface*>(this);
    if (type == QAccessible::AttributesInterface && (kind == QAccessible::Heading || isCell() || isList())) return static_cast<QAccessibleAttributesInterface*>(this);
    if (type == QAccessible::TableInterface && kind == QAccessible::Table) return static_cast<QAccessibleTableInterface*>(this);
    if (type == QAccessible::TableCellInterface && isCell()) return static_cast<QAccessibleTableCellInterface*>(this);
    return nullptr;
  }
  QString imageDescription() const override { return name; }
  QSize imageSize() const override { return rect().size(); }
  QPoint imagePosition() const override { return rect().topLeft(); }
  QString anchor() const override { return name; }
  QString anchorTarget() const override { return target; }
  int startIndex() const override { return start; }
  int endIndex() const override { return end; }
  QList<QAccessible::Attribute> attributeKeys() const override {
    if (kind == QAccessible::Heading) return {QAccessible::Attribute::Level};
    if (kind == QAccessible::ListItem) return {QAccessible::Attribute::Level, QAccessible::Attribute::Custom};
    if (kind == QAccessible::List) return {QAccessible::Attribute::Custom};
    if (isCell()) return {QAccessible::Attribute::Custom};
    return {};
  }
  QVariant attributeValue(QAccessible::Attribute key) const override {
    if ((kind == QAccessible::Heading || kind == QAccessible::ListItem) && key == QAccessible::Attribute::Level) return QVariant(level);
    if (isList() && key == QAccessible::Attribute::Custom) {
      QHash<QString, QString> values;
      values.insert(QStringLiteral("tag"), kind == QAccessible::ListItem ? QStringLiteral("li") : orderedList ? QStringLiteral("ol") : QStringLiteral("ul"));
      if (kind == QAccessible::ListItem) {
        values.insert(QStringLiteral("posinset"), QString::number(listPosition));
        values.insert(QStringLiteral("setsize"), QString::number(listSize));
        if (orderedList) values.insert(QStringLiteral("value"), QString::number(listNumber));
      } else if (orderedList) values.insert(QStringLiteral("start"), QString::number(listNumber));
      return QVariant::fromValue(values);
    }
    if (isCell() && key == QAccessible::Attribute::Custom)
      return QVariant::fromValue(QHash<QString, QString>{{QStringLiteral("tag"), cellHeader ? QStringLiteral("th") : QStringLiteral("td")},
                                                        {QStringLiteral("scope"), scope}});
    return {};
  }
  QStringList actionNames() const override {
    return kind == QAccessible::Link && isValid() && view_->isEnabled() && !target.isEmpty()
      ? QStringList{QAccessibleActionInterface::pressAction()} : QStringList();
  }
  void doAction(const QString& action) override {
    if (action == QAccessibleActionInterface::pressAction() && actionNames().contains(action))
      emit view_->linkActivated(target); // MainWindow retains local-path and external-URL confirmation checks.
  }
  QStringList keyBindingsForAction(const QString&) const override { return {}; }

  QAccessibleInterface* caption() const override { return nullptr; }
  QAccessibleInterface* summary() const override { return nullptr; }
  int rowCount() const override { return textTable ? textTable->rows() : 0; }
  int columnCount() const override { return textTable ? textTable->columns() : 0; }
  QAccessibleInterface* cellAt(int r, int c) const override {
    if (r < 0 || c < 0 || r >= rowCount() || c >= columnCount()) return nullptr;
    for (auto id : children) {
      auto* item = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id));
      if (item && r >= item->row && r < item->row + item->rowSpan && c >= item->column && c < item->column + item->columnSpan) return item;
    }
    return nullptr;
  }
  QString columnDescription(int c) const override {
    if (c < 0 || c >= columnCount()) return {};
    QStringList labels;
    for (auto id : children) {
      auto* header = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id));
      if (header && header->kind == QAccessible::ColumnHeader && (header->scope == "col" || header->scope == "auto")
          && c >= header->column && c < header->column + header->columnSpan) labels.append(header->name);
    }
    return labels.join(QLatin1Char('\n'));
  }
  QString rowDescription(int r) const override {
    if (r < 0 || r >= rowCount()) return {};
    QStringList labels;
    for (auto id : children) {
      auto* header = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id));
      if (header && header->kind == QAccessible::RowHeader && header->scope == "row"
          && r >= header->row && r < header->row + header->rowSpan) labels.append(header->name);
    }
    return labels.join(QLatin1Char('\n'));
  }
  bool isSelected() const override {
    if (!isValid() || !textTable || row < 0) return false;
    const auto selection = view_->selectionState();
    const int low = qMin(selection.first, selection.second), high = qMax(selection.first, selection.second);
    if (low == high) return false;
    QTextCursor cursor(view_->document());
    cursor.setPosition(low); cursor.setPosition(high, QTextCursor::KeepAnchor);
    if (cursor.hasComplexSelection() && cursor.currentTable() == textTable) {
      int firstRow, rows, firstColumn, columns;
      cursor.selectedTableCells(&firstRow, &rows, &firstColumn, &columns);
      return row >= firstRow && row + rowSpan <= firstRow + rows && column >= firstColumn && column + columnSpan <= firstColumn + columns;
    }
    return start < end && low <= start && high >= end;
  }
  QList<QAccessibleInterface*> selectedCells() const override {
    QList<QAccessibleInterface*> result;
    for (auto id : children) {
      auto* item = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id));
      if (item && item->isSelected()) result.append(item);
    }
    return result;
  }
  int selectedCellCount() const override { return selectedCells().size(); }
  bool isRowSelected(int r) const override {
    if (r < 0 || r >= rowCount()) return false;
    for (int c = 0; c < columnCount(); ++c) { auto* cell = cellAt(r, c); if (!cell || !cell->tableCellInterface()->isSelected()) return false; }
    return true;
  }
  bool isColumnSelected(int c) const override {
    if (c < 0 || c >= columnCount()) return false;
    for (int r = 0; r < rowCount(); ++r) { auto* cell = cellAt(r, c); if (!cell || !cell->tableCellInterface()->isSelected()) return false; }
    return true;
  }
  QList<int> selectedRows() const override { QList<int> result; for (int r = 0; r < rowCount(); ++r) if (isRowSelected(r)) result.append(r); return result; }
  QList<int> selectedColumns() const override { QList<int> result; for (int c = 0; c < columnCount(); ++c) if (isColumnSelected(c)) result.append(c); return result; }
  int selectedRowCount() const override { return selectedRows().size(); }
  int selectedColumnCount() const override { return selectedColumns().size(); }
  // DocumentView has a text selection, not independent row/column selections.
  bool selectRow(int) override { return false; }
  bool selectColumn(int) override { return false; }
  bool unselectRow(int) override { return false; }
  bool unselectColumn(int) override { return false; }
  void modelChange(QAccessibleTableModelChangeEvent*) override {}
  int rowIndex() const override { return row; }
  int columnIndex() const override { return column; }
  int rowExtent() const override { return rowSpan; }
  int columnExtent() const override { return columnSpan; }
  QAccessibleInterface* table() const override { return parent(); }
  QList<QAccessibleInterface*> columnHeaderCells() const override {
    QList<QAccessibleInterface*> result;
    auto* parentTable = dynamic_cast<DocumentSemanticNode*>(parent());
    if (!parentTable || !isCell()) return result;
    for (auto id : parentTable->children) {
      auto* header = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id));
      if (header && header != this && header->kind == QAccessible::ColumnHeader
          && (header->scope == "col" || header->scope == "auto") && header->row < row
          && header->column < column + columnSpan && column < header->column + header->columnSpan) result.append(header);
    }
    return result;
  }
  QList<QAccessibleInterface*> rowHeaderCells() const override {
    QList<QAccessibleInterface*> result;
    auto* parentTable = dynamic_cast<DocumentSemanticNode*>(parent());
    if (!parentTable || !isCell()) return result;
    for (auto id : parentTable->children) {
      auto* header = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id));
      if (header && header != this && header->kind == QAccessible::RowHeader && header->scope == "row" && header->column < column
          && header->row < row + rowSpan && row < header->row + header->rowSpan) result.append(header);
    }
    return result;
  }
 private:
  AccessibleDocumentView* owner_;
  QPointer<DocumentView> view_;
};

AccessibleDocumentView::~AccessibleDocumentView() {
  delete observer_.data();
  clearSemantics();
}

void AccessibleDocumentView::clearSemantics() {
  const auto nodes = semanticNodes_;
  semanticNodes_.clear(); semanticRoots_.clear();
  for (auto id : nodes) if (QAccessible::accessibleInterface(id)) QAccessible::deleteAccessibleInterface(id);
}

QRect AccessibleDocumentView::semanticRect(int start, int end, QTextTable* table, int row, int column) const {
  const auto* v = view();
  if (!v || !v->document_) return {};
  QRectF rectangle;
  if (table && row >= 0 && column >= 0) {
    const auto cell = table->cellAt(row, column);
    if (!cell.isValid()) return {};
    for (auto block = cell.firstCursorPosition().block(); block.isValid() && block.position() <= cell.lastPosition(); block = block.next()) {
      const auto bounds = v->document_->documentLayout()->blockBoundingRect(block);
      rectangle = rectangle.isEmpty() ? bounds : rectangle.united(bounds);
    }
    const auto format = cell.format().toTableCellFormat();
    rectangle.adjust(-qMax<qreal>(0, format.leftPadding()), -qMax<qreal>(0, format.topPadding()),
                     qMax<qreal>(0, format.rightPadding()), qMax<qreal>(0, format.bottomPadding()));
  } else if (table) rectangle = v->document_->documentLayout()->frameBoundingRect(table);
  else {
    for (auto block = v->document_->findBlock(start); block.isValid() && block.position() < qMax(end, start + 1); block = block.next()) {
      if (!block.isVisible() || !block.layout()) continue;
      const auto bounds = v->document_->documentLayout()->blockBoundingRect(block);
      for (int i = 0; i < block.layout()->lineCount(); ++i) {
        const auto line = block.layout()->lineAt(i);
        const int begin = qMax(start - block.position(), line.textStart());
        const int finish = qMin(end - block.position(), line.textStart() + line.textLength());
        if (finish < begin || (finish == begin && start != end)) continue;
        const qreal left = line.cursorToX(begin), right = line.cursorToX(finish);
        QRectF part(bounds.left() + qMin(left, right), bounds.top() + line.y(), qMax<qreal>(1, qAbs(right - left)), line.height());
        rectangle = rectangle.isEmpty() ? part : rectangle.united(part);
      }
    }
  }
  if (rectangle.isEmpty()) return {};
  const auto block = v->document_->findBlock(start);
  const int node = table ? table->format().intProperty(QTextFormat::UserProperty + 21)
                         : block.blockFormat().intProperty(QTextFormat::UserProperty + 21);
  for (const auto& region : v->horizontalRegions_) if (region.node == node) { rectangle.translate(-region.scroll, 0); break; }
  rectangle.translate(v->contentLeft(), v->topPadding() - v->scrollValue());
  rectangle.translate(v->viewport()->mapToGlobal(QPoint()));
  return rectangle.toAlignedRect();
}

void AccessibleDocumentView::ensureSemantics() const {
  semanticsUsed_ = true;
  auto* v = view();
  if (!semanticsDirty_ || rebuildingSemantics_ || !v || !v->document_ || v->building_) return;
  rebuildingSemantics_ = true;
  semanticsDirty_ = false;
  QSet<QString> kept;
  QVector<QAccessible::Id> roots;
  bool reordered = false;
  QVector<QAccessible::Id> renamed;
  QVector<QAccessible::Id> attributesChanged, tablesChanged;
  QHash<QAccessible::Id, QVector<QAccessible::Id>> previousChildren;
  QHash<QAccessible::Id, QString> previousListMetadata;
  for (auto id : semanticNodes_) if (auto* item = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id))) {
    previousChildren.insert(id, item->children);
    if (item->isList()) previousListMetadata.insert(id, item->listMetadata());
  }
  auto acquire = [&](const QString& key, QAccessible::Role role, QAccessible::Id parent, int start, int end,
                     const QString& name = QString(), const QString& description = QString()) {
    kept.insert(key);
    auto id = semanticNodes_.value(key);
    auto* item = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id));
    if (item && item->kind != role) { QAccessible::deleteAccessibleInterface(id); item = nullptr; }
    if (!item) {
      item = new DocumentSemanticNode(const_cast<AccessibleDocumentView*>(this));
      id = QAccessible::registerAccessibleInterface(item); semanticNodes_[key] = id; reordered = true;
    } else {
      if (item->name != name || item->description != description) renamed.append(id);
      if (item->parentId != parent) reordered = true;
    }
    item->kind = role; item->parentId = parent; item->start = start; item->end = end;
    item->name = name; item->description = description; item->children.clear();
    item->textTable = nullptr; item->target.clear(); item->level = 0; item->row = -1; item->column = -1;
    if (!parent) roots.append(id);
    else if (auto* parentItem = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(parent))) parentItem->children.append(id);
    return item;
  };
  auto inlines = [&](const QTextBlock& block, QAccessible::Id parent, const QString& key) {
    int ordinal = 0;
    DocumentSemanticNode* previousLink = nullptr;
    for (auto it = block.begin(); !it.atEnd(); ++it) {
      const auto fragment = it.fragment(); const auto format = fragment.charFormat();
      if (!fragment.isValid()) continue;
      const bool imageMetadata = format.hasProperty(QTextFormat::UserProperty + 17);
      const bool image = imageMetadata && fragment.text().contains(QChar::ObjectReplacementCharacter);
      QAccessible::Id inlineParent = parent;
      if (format.isAnchor() && !format.anchorHref().isEmpty()) {
        QString label = plain(fragment.text());
        if (imageMetadata) label.replace(QChar::ObjectReplacementCharacter, format.stringProperty(QTextFormat::UserProperty + 18));
        if (previousLink && previousLink->end == fragment.position() && previousLink->target == format.anchorHref()) {
          previousLink->end += fragment.length(); previousLink->name += label;
        } else {
          previousLink = acquire(key + "/l" + QString::number(ordinal++), QAccessible::Link, parent,
                                 fragment.position(), fragment.position() + fragment.length(), label,
                                 format.stringProperty(QTextFormat::UserProperty + 20));
          previousLink->target = format.anchorHref();
        }
        inlineParent = QAccessible::uniqueId(previousLink);
      } else previousLink = nullptr;
      if (image) {
        // Identical adjacent image atoms can share one QTextFragment.
        for (int n = 0; n < fragment.length(); ++n) {
          if (fragment.text().at(n) != QChar::ObjectReplacementCharacter) continue;
          acquire(key + "/i" + QString::number(ordinal++), QAccessible::Graphic, inlineParent,
                  fragment.position() + n, fragment.position() + n + 1,
                  format.stringProperty(QTextFormat::UserProperty + 18), format.stringProperty(QTextFormat::UserProperty + 19));
        }
      }
    }
  };
  QSet<QTextTable*> tables;
  int tableNumber = 0;
  struct ListContext {
    int depth, segment, quoteDepth, lastNumber;
    bool ordered;
    DocumentSemanticNode* list;
    DocumentSemanticNode* item;
  };
  QVector<ListContext> lists;
  auto blockLabel = [](const QTextBlock& block) {
    QString label;
    for (auto it = block.begin(); !it.atEnd(); ++it) {
      const auto fragment = it.fragment();
      if (!fragment.isValid() || fragment.charFormat().boolProperty(QTextFormat::UserProperty + 12)) continue;
      QString part = plain(fragment.text());
      if (fragment.charFormat().hasProperty(QTextFormat::UserProperty + 17))
        part.replace(QChar::ObjectReplacementCharacter, fragment.charFormat().stringProperty(QTextFormat::UserProperty + 18));
      label += part;
    }
    return label;
  };
  auto extendLists = [&](int end) {
    for (auto& context : lists) {
      context.list->end = qMax(context.list->end, end);
      if (context.item) context.item->end = qMax(context.item->end, end);
    }
  };
  for (auto block = v->document_->begin(); block.isValid(); block = block.next()) {
    if (!block.isVisible()) continue;
    if (block.blockFormat().hasProperty(QTextFormat::UserProperty + 28)) continue;
    QTextCursor cursor(block);
    // DocumentView's sentinel and post-table padding are layout-only blocks,
    // unlike authored paragraphs which always have RoleProperty. They cannot
    // terminate a list or become part of an item's accessible name.
    if (!cursor.currentTable() && !block.blockFormat().hasProperty(QTextFormat::UserProperty + 1)) continue;
    if (!cursor.currentTable()) {
      const auto format = block.blockFormat();
      const int depth = format.intProperty(QTextFormat::UserProperty + 15);
      const int segment = format.intProperty(QTextFormat::UserProperty + 6);
      if (!format.hasProperty(QTextFormat::UserProperty + 15) || (!lists.isEmpty() && lists.first().segment != segment)) lists.clear();
      if (format.hasProperty(QTextFormat::UserProperty + 15)) {
        while (!lists.isEmpty() && lists.last().depth > depth) lists.removeLast();
        // Only real item starts carry a number; continuation paragraphs keep
        // depth alone and stay in the preceding item, not a fabricated new one.
        if (format.hasProperty(QTextFormat::UserProperty + 14)) {
          const bool ordered = format.boolProperty(QTextFormat::UserProperty + 13);
          const int number = format.intProperty(QTextFormat::UserProperty + 14);
          const int quoteDepth = format.intProperty(QTextFormat::UserProperty + 23);
          const bool sameList = !lists.isEmpty() && lists.last().depth == depth && lists.last().ordered == ordered
            && lists.last().quoteDepth == quoteDepth && lists.last().lastNumber + 1 == number;
          if (!sameList) {
            if (!lists.isEmpty() && lists.last().depth == depth) lists.removeLast();
            const auto parent = lists.isEmpty() || !lists.last().item ? 0 : QAccessible::uniqueId(lists.last().item);
            auto* list = acquire("list/b" + QString::number(block.blockNumber()), QAccessible::List, parent,
                                 block.position(), block.position(), ordered ? QStringLiteral("有序列表") : QStringLiteral("无序列表"));
            list->orderedList = ordered; list->listNumber = number;
            lists.append({depth, segment, quoteDepth, number - 1, ordered, list, nullptr});
          }
          auto& context = lists.last();
          auto* item = acquire("item/b" + QString::number(block.blockNumber()), QAccessible::ListItem,
                               QAccessible::uniqueId(context.list), block.position(), block.position());
          item->level = depth + 1; item->orderedList = ordered; item->listNumber = number;
          context.item = item; context.lastNumber = number;
        }
      }
    }
    const auto listParent = lists.isEmpty() || !lists.last().item ? 0 : QAccessible::uniqueId(lists.last().item);
    if (auto* table = cursor.currentTable()) {
      if (tables.contains(table)) continue;
      tables.insert(table);
      const QString key = "t" + QString::number(tableNumber++);
      auto* tableNode = acquire(key, QAccessible::Table, listParent, table->firstPosition(), table->lastPosition());
      extendLists(table->lastPosition());
      tableNode->textTable = table;
      const auto tableId = QAccessible::uniqueId(tableNode);
      const bool hasHeader = !table->format().boolProperty(QTextFormat::UserProperty + 30);
      QString shape = QString::number(table->rows()) + "," + QString::number(table->columns()) + "," + QString::number(hasHeader);
      for (int r = 0; r < table->rows(); ++r) for (int c = 0; c < table->columns(); ++c) {
        const auto cell = table->cellAt(r, c);
        if (cell.row() != r || cell.column() != c) continue;
        const int end = cell.lastCursorPosition().position();
        auto first = cell.firstCursorPosition().block();
        while (first.isValid() && first.position() < end && !first.blockFormat().hasProperty(QTextFormat::UserProperty + 6)) first = first.next();
        const int start = first.isValid() && first.position() <= end ? first.position() : cell.firstCursorPosition().position();
        const QString cellKey = key + "/" + QString::number(r) + "," + QString::number(c);
        const auto format = cell.format();
        // Qt appends a separator and the covered cells' invisible padding when
        // merging. Only raw, read-only previews have this authored extent; do
        // not trim actual spaces or ZWSPs, or cache editable Markdown lengths.
        const int labelEnd = (cell.rowSpan() > 1 || cell.columnSpan() > 1) && format.hasProperty(QTextFormat::UserProperty + 35)
          ? qMin(end, start + qMax(0, format.intProperty(QTextFormat::UserProperty + 35))) : end;
        QStringList labels;
        for (auto inner = first; inner.isValid() && inner.position() < labelEnd; inner = inner.next())
          if (inner.blockFormat().hasProperty(QTextFormat::UserProperty + 6)) labels.append(plain(inner.text().left(labelEnd - inner.position())));
        while (!labels.isEmpty() && labels.last().isEmpty()) labels.removeLast();
        const bool cellHeader = format.hasProperty(QTextFormat::UserProperty + 33) ? format.boolProperty(QTextFormat::UserProperty + 33) : hasHeader && r == 0;
        const QString scope = format.hasProperty(QTextFormat::UserProperty + 34) ? format.stringProperty(QTextFormat::UserProperty + 34)
                                                                              : cellHeader ? QStringLiteral("col") : QStringLiteral("auto");
        // A retained group scope states direction, but group membership/headers=id
        // are not modeled. Do not fabricate associations for those complex cases.
        const auto role = !cellHeader ? QAccessible::Cell
          : scope == "row" || scope == "rowgroup" ? QAccessible::RowHeader
          : scope == "col" || scope == "colgroup" || (scope == "auto" && r == 0) ? QAccessible::ColumnHeader : QAccessible::Cell;
        auto* cellNode = acquire(cellKey, role,
                                 tableId, start, end, labels.join(QLatin1Char('\n')));
        if (!cellNode->scope.isEmpty() && (cellNode->scope != scope || cellNode->cellHeader != cellHeader)) attributesChanged.append(QAccessible::uniqueId(cellNode));
        cellNode->cellHeader = cellHeader; cellNode->scope = scope;
        cellNode->textTable = table; cellNode->row = r; cellNode->column = c;
        cellNode->rowSpan = cell.rowSpan(); cellNode->columnSpan = cell.columnSpan();
        shape += ";" + QString::number(r) + "," + QString::number(c) + "," + QString::number(cell.rowSpan()) + "," + QString::number(cell.columnSpan())
                  + "," + QString::number(cellHeader) + "," + scope;
        const auto cellId = QAccessible::uniqueId(cellNode);
        for (auto inner = first; inner.isValid() && inner.position() < end; inner = inner.next()) inlines(inner, cellId, cellKey + "/b" + QString::number(inner.blockNumber()));
      }
      if (!tableNode->modelShape.isEmpty() && tableNode->modelShape != shape) tablesChanged.append(tableId);
      tableNode->modelShape = shape;
      continue;
    }
    const QString key = "b" + QString::number(block.blockNumber());
    QAccessible::Id parent = listParent;
    if (listParent) {
      auto* item = lists.last().item;
      const auto label = blockLabel(block);
      if (!label.isEmpty()) { if (!item->name.isEmpty()) item->name += QLatin1Char('\n'); item->name += label; }
      extendLists(block.position() + block.length() - 1);
    }
    if (block.blockFormat().intProperty(QTextFormat::UserProperty + 1) == 1) {
      auto* previous = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(semanticNodes_.value(key)));
      const int oldLevel = previous ? previous->level : -1;
      auto* heading = acquire(key, QAccessible::Heading, parent, block.position(), block.position() + block.length() - 1, blockLabel(block));
      heading->level = block.blockFormat().intProperty(QTextFormat::UserProperty + 7);
      parent = QAccessible::uniqueId(heading);
      if (oldLevel >= 0 && oldLevel != heading->level) attributesChanged.append(parent);
    }
    inlines(block, parent, key);
  }
  for (auto id : semanticNodes_) if (auto* list = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id))) {
    if (list->kind != QAccessible::List) continue;
    int position = 0;
    for (auto child : list->children) if (auto* item = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(child))) {
      item->listPosition = ++position; item->listSize = list->children.size();
    }
  }
  const auto oldNodes = semanticNodes_;
  for (auto it = oldNodes.cbegin(); it != oldNodes.cend(); ++it) if (!kept.contains(it.key())) {
    semanticNodes_.remove(it.key());
    if (QAccessible::accessibleInterface(it.value())) QAccessible::deleteAccessibleInterface(it.value());
    reordered = true;
  }
  reordered |= roots != semanticRoots_;
  for (auto id : semanticNodes_) if (auto* item = dynamic_cast<DocumentSemanticNode*>(QAccessible::accessibleInterface(id))) {
    if (previousChildren.contains(id) && previousChildren.value(id) != item->children) reordered = true;
    if (previousListMetadata.contains(id) && previousListMetadata.value(id) != item->listMetadata()) attributesChanged.append(id);
  }
  semanticRoots_ = roots;
  rebuildingSemantics_ = false;
  if (reordered) { QAccessibleEvent event(v, QAccessible::ObjectReorder); QAccessible::updateAccessibility(&event); }
  for (auto id : renamed) if (auto* item = QAccessible::accessibleInterface(id)) {
    QAccessibleEvent event(item, QAccessible::NameChanged); QAccessible::updateAccessibility(&event);
  }
  for (auto id : attributesChanged) if (auto* item = QAccessible::accessibleInterface(id)) {
    QAccessibleEvent event(item, QAccessible::ObjectAttributeChanged); QAccessible::updateAccessibility(&event);
  }
  for (auto id : tablesChanged) if (auto* item = QAccessible::accessibleInterface(id)) {
    QAccessibleTableModelChangeEvent event(item, QAccessibleTableModelChangeEvent::ModelReset); QAccessible::updateAccessibility(&event);
  }
}

int AccessibleDocumentView::childCount() const {
  ensureSemantics();
  return semanticRoots_.size() + QAccessibleWidget::childCount();
}
QAccessibleInterface* AccessibleDocumentView::child(int index) const {
  ensureSemantics();
  if (index < 0) return nullptr;
  if (index < semanticRoots_.size()) return QAccessible::accessibleInterface(semanticRoots_.at(index));
  return QAccessibleWidget::child(index - semanticRoots_.size());
}
int AccessibleDocumentView::indexOfChild(const QAccessibleInterface* item) const {
  ensureSemantics();
  for (int i = 0; i < semanticRoots_.size(); ++i) if (QAccessible::accessibleInterface(semanticRoots_.at(i)) == item) return i;
  const int base = QAccessibleWidget::indexOfChild(item);
  return base < 0 ? -1 : semanticRoots_.size() + base;
}
QAccessibleInterface* AccessibleDocumentView::childAt(int x, int y) const {
  ensureSemantics();
  const auto* v = view();
  const int offset = v && v->document_ ? v->document_->documentLayout()->hitTest(
    v->hitDocumentPoint(v->viewport()->mapFromGlobal(QPoint(x, y))), Qt::FuzzyHit) : -1;
  for (auto id : semanticRoots_) if (auto* item = QAccessible::accessibleInterface(id))
    if (auto* semantic = dynamic_cast<DocumentSemanticNode*>(item))
      if (offset >= semantic->start && offset <= semantic->end && !item->state().invisible && item->rect().contains(x, y)) return item;
  return QAccessibleWidget::childAt(x, y);
}

namespace {
QAccessibleInterface* documentFactory(const QString& key, QObject* object) {
  if (key == QLatin1String("DocumentView"))
    if (auto* view = qobject_cast<DocumentView*>(object)) return new AccessibleDocumentView(view);
  return nullptr;
}
}

void installDocumentAccessibility() {
  static const bool installed = [] { QAccessible::installFactory(documentFactory); return true; }();
  Q_UNUSED(installed);
}
