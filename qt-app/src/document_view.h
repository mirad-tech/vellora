// Reading surface for the neutral block plan produced by the Rust engine.
//
// The document is laid out by QTextDocument, but every surface decoration that
// the legacy stylesheet expresses with CSS (12px rounded code blocks, the 2px
// quote rule, the rounded table frame with hairline grid, 6px rounded images and
// the thin overlay scrollbar) is painted here instead of being approximated with
// square QTextFormat backgrounds. That is the whole point of this class: Qt's
// text formats cannot express those shapes, so the widget draws them.
#pragma once

#include <QAbstractScrollArea>
#include <QJsonObject>
#include <QJsonArray>
#include <QHash>
#include <QPointer>
#include <QCache>
#include <QImage>
#include <QBuffer>
#include <QMovie>
#include <QElapsedTimer>
#include <QTextObjectInterface>
#include <functional>
#include <QSet>
#include <QTextCursor>
#include <QTextBlock>
#include <QTextLayout>
#include <QTimer>
#include <QVector>

class QTextBlock;
class QTextDocument;
class QTextTable;
class QPainter;
class QPushButton;
class QPropertyAnimation;
class AccessibleDocumentView;

class RawPreviewObject final : public QObject, public QTextObjectInterface {
  Q_OBJECT
  Q_INTERFACES(QTextObjectInterface)
 public:
  explicit RawPreviewObject(QObject* parent) : QObject(parent) {}
  std::function<QSizeF(const QTextFormat&)> measure;
  std::function<void(QPainter*, const QRectF&, const QTextFormat&)> paint;
  QSizeF intrinsicSize(QTextDocument*, int, const QTextFormat& format) override;
  void drawObject(QPainter* painter, const QRectF& rect, QTextDocument*, int, const QTextFormat& format) override { if (paint) paint(painter, rect, format); }
};

class DocumentView : public QAbstractScrollArea {
  friend class AccessibleDocumentView;
  friend class FeedbackDocumentRegressions;
  friend class ParityDocumentRegressions;
  friend class BodyLayoutRegressions;
  friend class ImeRawRegressions;
  friend class FidelityRegressions;
  Q_OBJECT

 public:
  explicit DocumentView(QWidget* parent = nullptr);

  void setPlan(const QJsonObject& plan, const QString& documentPath);
  void setPreviewContext(const QString& markdown);
  void setEmptyState();
  void setErrorState(const QString& message);
  void setSearchQuery(const QString& query, bool active);
  int searchMatchCount() const { return matchCount_; }
  int searchActiveIndex() const { return activeMatch_; }
  QString selectedText() const;
  QJsonObject selectionMime() const;
  bool isComposing() const { return !preedit_.isEmpty(); }
  bool replaceCurrent(const QString& replacement);
  int replaceAll(const QString& replacement);
  int replacementChangeCount(const QString& replacement) const;
  void focusSearchResult(int index);
  bool revealText(const QString& text);
  bool revealHeading(int index);
  int currentHeadingIndex() const;
  QJsonObject readingAnchor() const;
  bool restoreReadingAnchor(const QJsonObject& anchor);
  QPair<int,int> selectionState() const { return {cursor_.anchor(), cursor_.position()}; }
  void restoreSelectionState(const QPair<int,int>& state);
  void setScrollValue(int value);

  /// Document mode is editable: paragraphs and headings accept inline text
  /// edits that are spliced back per segment on save, so blocks the user did not
  /// touch keep their exact bytes.
  bool hasPendingEdits() const { return !pendingEdits().isEmpty(); }
  QVector<QPair<int, QString>> pendingEdits() const;
  void clearPendingEdits() { dirtySegments_.clear(); }
  int scrollValue() const;

  QTextDocument* document() const { return document_; }

 signals:
  void linkActivated(const QString& href);
  void openRequested();
  void sourceEditRequested();
  void contentEdited();
  void viewportChanged();

 protected:
  // A platform writer can be substituted without touching the desktop clipboard.
  virtual bool writeCodeClipboard(const QString& text);
  void copyCodeText(int node, const QString& text);
  void paintEvent(QPaintEvent* event) override;
  void resizeEvent(QResizeEvent* event) override;
  void mousePressEvent(QMouseEvent* event) override;
  void mouseMoveEvent(QMouseEvent* event) override;
  void mouseReleaseEvent(QMouseEvent* event) override;
  void mouseDoubleClickEvent(QMouseEvent* event) override;
  void wheelEvent(QWheelEvent* event) override;
  void inputMethodEvent(QInputMethodEvent* event) override;
  QVariant inputMethodQuery(Qt::InputMethodQuery query) const override;
  void focusInEvent(QFocusEvent* event) override;
  void hideEvent(QHideEvent* event) override;
  void focusOutEvent(QFocusEvent* event) override;
  void keyPressEvent(QKeyEvent* event) override;
  bool focusNextPrevChild(bool next) override;
  void leaveEvent(QEvent* event) override;
  void contextMenuEvent(QContextMenuEvent* event) override;

 private:
  struct CodeBox {
    QRectF rect;
  };
  struct QuoteBar {
    QRectF rect;
  };
  struct RuleLine {
    QPointF from;
    QPointF to;
  };
  struct ImageBox {
    QRectF rect;
    QString path;
    bool rounded = true;
  };
  struct TableBox {
    QRectF rect;
    QVector<qreal> rows;
    QVector<qreal> columns;
    qreal scroll = 0;
    QVector<QLineF> grid;
    bool header = true;
  };
  struct InlineBox {
    QRectF rect;
  };
  struct TableRef {
    QTextTable* table = nullptr;
    QVector<qreal> natural;
  };

  /// A table whose natural width exceeds the reading column. QTextTable cannot
  /// scroll horizontally (negative block margins are clamped), so these are
  /// reserved by a spacer block and painted by hand with their own scroll state.
  struct TableRun {
    QString text;
    bool bold = false;
    bool italic = false;
    bool strike = false;
    bool code = false;
    QString href;
  };
  struct PaintedTable {
    int blockPosition = 0;
    QRectF rect;
    QVector<qreal> columns;
    QVector<QVector<QVector<TableRun>>> cells;
    qreal columnWidth = 0;
    qreal scroll = 0;
    qreal maxScroll = 0;
    QRectF scrollTrack;
    QRectF scrollThumb;
  };

  void buildDocument(const QJsonObject& plan);
  void relayout();
  bool refreshParagraphIndents(const QTextBlock& only = QTextBlock());
  void rebuildDecorations();
  void updateScrollRange();
  int contentWidth() const;
  int topPadding() const { return previewMode_ ? 0 : 32; }
  int bottomPadding() const { return previewMode_ ? 0 : width() < 760 ? 64 : 80; }
  struct RawSurface {
    int node = -1;
    QPointer<DocumentView> preview;
    bool source = false;
    QJsonObject plan;
  };
  QHash<int, RawSurface> rawSurfaces_;
  bool previewMode_ = false;
  bool taskListPreview_ = false;
  bool readOnly_ = false;
  void layoutRawSurfaces();
  void setRawSourceVisible(int node, bool source, bool focusEditor = true);
  int contentLeft() const;
  QPointF toDocument(const QPoint& viewportPosition) const;
  QPointF hitDocumentPoint(const QPoint& viewportPosition) const;
  struct HorizontalRegion {
    int node = -1;
    int blockPosition = -1;
    QRectF rect;
    qreal scroll = 0;
    qreal maximum = 0;
    QRectF track;
    QRectF thumb;
    QRectF copy;
  };
  QVector<HorizontalRegion> horizontalRegions_;
  QHash<int, qreal> horizontalOffsets_;
  int draggingRegion_ = -1;
  int copiedNode_ = -1;
  int copyErrorNode_ = -1;
  QTimer* copyFeedbackTimer_ = nullptr;
  void resetCodeCopyFeedback();
  QRectF codeTextBounds(const QTextBlock& block, const QRectF& blockRect) const;

  void clearSearchHighlight();
  void stopHeadingScroll();
  void scrollToHeadingPosition(int position);
  QPropertyAnimation* headingScroll_ = nullptr;
  void applySearchHighlight(const QString& query);
  void paintDecorations(QPainter& painter);
  void paintTables(QPainter& painter);
  void paintCaret(QPainter& painter);

  int segmentOf(const QTextBlock& block) const;
  bool blockEditable(const QTextBlock& block) const;
  QString serializeSegment(int segment) const;
  QString serializeNode(const QJsonObject& node) const;
  QString serializeFlatSegment(int segment) const;
  void changeListLevel(int delta, bool exitList = false);
  void snapshotBlocks();
  void replaceRange(QTextCursor& range, const QString& text);
  void refreshAfterEdit();
  void refreshBlockGeometry(const QTextBlock& block);
  void refreshTableGeometry(const QTextBlock& block);
  QString inlineMarkdown(const QTextBlock& block) const;
  QRectF caretRectangle() const;
  void ensureCaretVisible();
  void moveCursor(QTextCursor::MoveOperation operation, QTextCursor::MoveMode mode);
  void insertTyped(const QString& text);
  void deleteBackward();
  void deleteForward();
  void splitBlockAtCursor();
  bool protectNestedStructure(const QTextCursor& range);
  void resetCaretBlink();
  void clearPreeditLayout();
  void copySelection();
  void paintEmptyState(QPainter& painter);

  QTextDocument* document_ = nullptr;
  QTextCursor cursor_;
  QString documentPath_;
  QString previewContext_;
  QSet<QString> authorizedImages_;
  QHash<QString,QString> imageSources_;
  QHash<QString,QSize> imageSizes_;
  struct AnimatedImage { QBuffer buffer; QMovie movie; AnimatedImage(const QByteArray& bytes): movie(&buffer) { buffer.setData(bytes); buffer.open(QIODevice::ReadOnly); } };
  QCache<QString,AnimatedImage> animationCache_{32 * 1024};
  QSet<QString> paintedImages_;
  QCache<QString, QImage> imageCache_{64 * 1024};
  QImage decodedImage(const QString& path);
  QString query_;
  int matchCount_ = 0;
  QVector<QTextCursor> matches_;
  int activeMatch_ = -1;
  bool searchSelection_ = false;
  bool empty_ = true;
  QString errorMessage_;

  QVector<CodeBox> codeBoxes_;
  QVector<QuoteBar> quoteBars_;
  QVector<RuleLine> ruleLines_;
  QVector<ImageBox> imageBoxes_;
  QVector<TableBox> tableBoxes_;
  QVector<InlineBox> inlineBoxes_;
  QVector<TableRef> tableRefs_;
  QVector<PaintedTable> paintedTables_;
  int draggingTable_ = -1;
  qreal dragStartX_ = 0;
  qreal dragStartScroll_ = 0;
  QRectF emptyButtonRect_;
  bool dragging_ = false;
  QElapsedTimer doubleClickTimer_;
  int doubleClickedBlock_ = -1;
  QSet<int> editableSegments_;
  QSet<int> dirtySegments_;
  QJsonArray modelTree_;
  QHash<QByteArray, QByteArray> originalReferenceFingerprints_;
  QHash<int, QString> baselineSegments_;
  QHash<int, QVector<QTextBlock>> nodeBlocks_;
  QHash<int, QVector<QTextBlock>> segmentBlocks_;
  QHash<int, QJsonObject> segmentModels_;
  struct BlockSnapshot { int start; int end; int segment; int node; int role; };
  QVector<BlockSnapshot> blockSnapshot_;
  QHash<int,QRectF> blockRectCache_;
  qreal cachedDocumentHeight_ = -1;
  QTextBlock pendingGeometryBlock_;
  bool fullGeometryPending_ = false;
  QTimer* caretTimer_ = nullptr;
  bool caretOn_ = true;
  bool building_ = false;
  bool suppressEdits_ = false;
  bool layoutQueued_ = false;
  QString preedit_;
  QTextBlock preeditBlock_;
  QList<QTextLayout::FormatRange> preeditBaseFormats_;
  int preeditPosition_ = 0;
  int preeditCursor_ = 0;
  bool preeditCursorVisible_ = true;
  QColor preeditCursorColor_;
  bool typingContinuation_ = false;
  int lastTypingPosition_ = -1;
};
