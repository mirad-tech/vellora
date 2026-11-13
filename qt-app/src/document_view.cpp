#include "document_view.h"
#include "image_decode.h"
#include "document_accessibility.h"

#include <QAbstractTextDocumentLayout>
#include <QApplication>
#include <QClipboard>
#include <QAccessible>
#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif
#include <cstring>
#include <QMimeData>
#include <QTextDocumentFragment>
#include <QInputMethodEvent>
#include <QInputMethod>
#include <QDir>
#include <QFile>
#include <QTextStream>
#include <QFontDatabase>
#include <QFontInfo>
#include <QFontMetricsF>
#include <QImage>
#include <QImageReader>
#include <QUrl>
#include <QJsonArray>
#include <QJsonDocument>
#include <QToolTip>
#include <QCryptographicHash>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QPainter>
#include <QPainterPath>
#include <QPalette>
#include <QScrollBar>
#include <QTextBlock>
#include <QTextDocument>
#include <QTextFragment>
#include <QTextFrame>
#include <QTextLayout>
#include <QTextTable>
#include <QWheelEvent>
#include <QTextTableCell>
#include <QTimer>
#include <QRegularExpression>
#include <QPushButton>
#include <QPropertyAnimation>
#include <QMenu>
#include <QContextMenuEvent>
#include <QSyntaxHighlighter>
#include "code_highlight.h"
#include <QtMath>

#include <algorithm>
#include <type_traits>

#include <functional>
#include <limits>

#include "bridge.h"
#include "theme.h"

namespace {

constexpr int kBody = 16;
constexpr int kCode = 14;
constexpr int kRadiusCode = 12;
constexpr int kRadiusContent = 6;


constexpr qreal kInlineCodePadX = 4.9;   // 0.35em at 14px
constexpr qreal kInlineCodePadY = 1.4;   // 0.1em

class SafeImageDocument final : public QTextDocument {
 public:
  explicit SafeImageDocument(QObject* parent) : QTextDocument(parent) {}
  std::function<QVariant(const QUrl&)> imageLoader;
 protected:
  QVariant loadResource(int type, const QUrl& name) override {
    if (type == QTextDocument::ImageResource && imageLoader) return imageLoader(name);
    // No implicit filesystem/network loading, even when untrusted Markdown
    // contains a URL that QTextDocument would otherwise know how to open.
    return {};
  }
};
QString normalizedImagePath(QString path) {
  return QDir::cleanPath(QDir::fromNativeSeparators(path)).toLower();
}

QJsonObject withTaskListSpacing(QJsonObject preview, const QString& source) {
  // The legacy raw Markdown preview retains HTML's inter-item newlines under
  // white-space:pre-wrap. Scope this to its task-list fallback, not ordinary
  // editable lists or compact user-authored HTML lists.
  static const QRegularExpression task(QStringLiteral("^[\\t ]*(?:[-+*]|[0-9]{1,9}[.)])[\\t ]+\\[[ xX]\\](?:[\\t ]|$)"));
  static const QRegularExpression list(QStringLiteral("^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[\\t ]+"));
  QString first;
  bool hasTask = false;
  for (const auto& line : source.split(QLatin1Char('\n'))) {
    if (first.isEmpty() && !line.trimmed().isEmpty()) first = line;
    hasTask = hasTask || task.match(line).hasMatch();
  }
  const auto blocks = preview.value("blocks").toArray();
  preview.insert("taskListWhitespace", !blocks.isEmpty() && blocks.first().toObject().value("type").toString() == "list" && list.match(first).hasMatch() && hasTask);
  return preview;
}

enum BlockRole {
  RoleBody = 0,
  RoleHeading = 1,
  RoleCode = 2,
  RoleQuote = 3,
  RoleTable = 4,
  RoleRule = 5,
  RoleImage = 6,
  RoleListItem = 7,
};

constexpr int RoleProperty = QTextFormat::UserProperty + 1;
constexpr int InlineCodeProperty = QTextFormat::UserProperty + 2;
constexpr int ImagePathProperty = QTextFormat::UserProperty + 3;
constexpr int ImageWidthProperty = QTextFormat::UserProperty + 4;
constexpr int ImageHeightProperty = QTextFormat::UserProperty + 5;
constexpr int SegmentProperty = QTextFormat::UserProperty + 6;
constexpr int HeadingLevelProperty = QTextFormat::UserProperty + 7;
constexpr int MarkBoldProperty = QTextFormat::UserProperty + 8;
constexpr int MarkItalicProperty = QTextFormat::UserProperty + 9;
constexpr int MarkStrikeProperty = QTextFormat::UserProperty + 10;
constexpr int SoftBreakProperty = QTextFormat::UserProperty + 11;
constexpr int ListMarkerProperty = QTextFormat::UserProperty + 12;
constexpr int ListOrderedProperty = QTextFormat::UserProperty + 13;
constexpr int ListNumberProperty = QTextFormat::UserProperty + 14;
constexpr int ListDepthProperty = QTextFormat::UserProperty + 15;
constexpr int CodeLanguageProperty = QTextFormat::UserProperty + 16;
constexpr int ImageSourceProperty = QTextFormat::UserProperty + 17;
constexpr int ImageAltProperty = QTextFormat::UserProperty + 18;
constexpr int ImageTitleProperty = QTextFormat::UserProperty + 19;
constexpr int LinkTitleProperty = QTextFormat::UserProperty + 20;
constexpr int NodeProperty = QTextFormat::UserProperty + 21;
constexpr int RawProperty = QTextFormat::UserProperty + 22;
constexpr int QuoteDepthProperty = QTextFormat::UserProperty + 23;
constexpr int TableRowProperty = QTextFormat::UserProperty + 24;
constexpr int TableColumnProperty = QTextFormat::UserProperty + 25;
constexpr int FlattenProperty = QTextFormat::UserProperty + 26;
constexpr int NewListItemProperty = QTextFormat::UserProperty + 27;
constexpr int RawPreviewOwnerProperty = QTextFormat::UserProperty + 28;
constexpr int StructureChangedProperty = QTextFormat::UserProperty + 29;
constexpr int HeaderIsBodyProperty = QTextFormat::UserProperty + 30;
constexpr int CellHeaderProperty = QTextFormat::UserProperty + 33;
constexpr int CellScopeProperty = QTextFormat::UserProperty + 34;
constexpr int AuthoredCellLengthProperty = QTextFormat::UserProperty + 35;
constexpr int TaskCheckedProperty = QTextFormat::UserProperty + 36;
constexpr int ListLooseProperty = QTextFormat::UserProperty + 37;
constexpr int QuoteListInsetsProperty = QTextFormat::UserProperty + 38;
constexpr int LinkReferenceProperty = QTextFormat::UserProperty + 39;
constexpr int ImageReferenceProperty = QTextFormat::UserProperty + 40;
constexpr int ImageAltSourceProperty = QTextFormat::UserProperty + 41;
constexpr int ImageAltOriginalProperty = QTextFormat::UserProperty + 42;
constexpr int ListDelimiterProperty = QTextFormat::UserProperty + 31;
constexpr int MissingImageProperty = QTextFormat::UserProperty + 32;
constexpr int RawPreviewObjectType = QTextFormat::UserObject + 1;
constexpr int SafeInlineImageObjectType = QTextFormat::UserObject + 2;
constexpr int BlockImageObjectType = QTextFormat::UserObject + 3;

class CodeSyntaxHighlighter final : public QSyntaxHighlighter {
 public:
  explicit CodeSyntaxHighlighter(QTextDocument* document) : QSyntaxHighlighter(document) {}
 protected:
  void highlightBlock(const QString& text) override {
    const auto format = currentBlock().blockFormat();
    if (format.intProperty(RoleProperty) != RoleCode || format.boolProperty(RawProperty)) return;
    for (const auto& range : codehighlight::ranges(text, format.stringProperty(CodeLanguageProperty)))
      setFormat(range.start, range.length, range.format);
  }
};

QString escapedText(const QString& text) {
  QString out;
  for (QChar c : text) {
    if (c == '&') out += QStringLiteral("&amp;");
    else if (c == '<') out += QStringLiteral("&lt;");
    else if (c == '>') out += QStringLiteral("&gt;");
    else {
      if (QStringLiteral("\\`*_[]~").contains(c)) out += QLatin1Char('\\');
      out += c;
    }
  }
  return out;
}

QString paragraphMarkdown(QString text) {
  if (text.isEmpty()) return QStringLiteral("&nbsp;");
  // Match the baseline SafeParagraph exporter: inline marks have already been
  // escaped, but every physical line must also be protected from block syntax.
  // Encoding indentation preserves the actual spaces/tabs without turning an
  // ordinary edited paragraph into an indented code block on its next open.
  static const QRegularExpression punctuation(QStringLiteral(R"(^([ \t]{0,3})([#>+=|:\-]))"));
  static const QRegularExpression ordered(QStringLiteral(R"(^([ \t]{0,3}\d+)([.)]))"));
  QStringList lines = text.split(QLatin1Char('\n'));
  for (QString& line : lines) {
    const auto mark = punctuation.match(line);
    const auto number = ordered.match(line);
    if (mark.hasMatch()) line.insert(mark.capturedStart(2), QLatin1Char('\\'));
    else if (number.hasMatch()) line.insert(number.capturedStart(2), QLatin1Char('\\'));
    int indent = 0;
    QString encoded;
    while (indent < line.size() && (line.at(indent) == QLatin1Char(' ') || line.at(indent) == QLatin1Char('\t'))) {
      encoded += line.at(indent) == QLatin1Char(' ') ? QStringLiteral("&#32;") : QStringLiteral("&#9;");
      ++indent;
    }
    if (indent) line.replace(0, indent, encoded);
  }
  return lines.join(QLatin1Char('\n'));
}
QString destination(QString text) {
  text.replace('&', QStringLiteral("&amp;"));
  text.replace('\\', QStringLiteral("\\\\"));
  text.replace('(', QStringLiteral("\\("));
  text.replace(')', QStringLiteral("\\)"));
  text.replace(' ', QStringLiteral("%20"));
  text.replace('\t', QStringLiteral("%09"));
  text.replace('\n', QStringLiteral("%0A"));
  return text;
}
QString titleSuffix(QString title) {
  if (title.isEmpty()) return {};
  title.replace('&', QStringLiteral("&amp;"));
  title.replace('\\', QStringLiteral("\\\\"));
  title.replace('"', QStringLiteral("\\\""));
  return QStringLiteral(" \"") + title + QStringLiteral("\"");
}
void applyRunMarks(QTextCharFormat& format, const QJsonObject& run) {
  if (run.value("bold").toBool()) { format.setProperty(MarkBoldProperty,true); format.setFontWeight(QFont::DemiBold); }
  if (run.value("italic").toBool()) { format.setProperty(MarkItalicProperty,true); format.setFontItalic(true); }
  if (run.value("strike").toBool()) { format.setProperty(MarkStrikeProperty,true); format.setFontStrikeOut(true); }
  const auto link=run.value("link").toObject();
  if (!link.isEmpty()) {
    format.setAnchor(true);format.setAnchorHref(link.value("href").toString());format.setProperty(LinkTitleProperty,link.value("title").toString());
    if (link.value("reference").isObject()) format.setProperty(LinkReferenceProperty,link.value("reference").toObject().toVariantMap());
  }
  if (run.value("kind").toString() == "image") {
    if (run.contains("altSource")) format.setProperty(ImageAltSourceProperty,run.value("altSource").toString());
    if (run.contains("altOriginal")) format.setProperty(ImageAltOriginalProperty,run.value("altOriginal").toString());
    if (run.value("reference").isObject()) format.setProperty(ImageReferenceProperty,run.value("reference").toObject().toVariantMap());
  }
}


// Fragment-boundary independent fingerprint of a reference label's semantic
// characters. Original Markdown is reused only when text AND marks are intact.
QByteArray referenceFingerprint(const QString& text, const QTextCharFormat& format) {
  QByteArray result;
  for (QChar character : text) {
    QJsonArray atom;
    atom.append(QString(character));
    for (int property : {InlineCodeProperty, MarkBoldProperty, MarkItalicProperty, MarkStrikeProperty, SoftBreakProperty})
      atom.append(format.boolProperty(property));
    atom.append(format.isAnchor()); atom.append(format.anchorHref());
    atom.append(format.stringProperty(LinkTitleProperty));
    for (int property : {ImageSourceProperty, ImageAltProperty, ImageTitleProperty, ImageAltSourceProperty, ImageAltOriginalProperty})
      atom.append(format.stringProperty(property));
    atom.append(QJsonObject::fromVariantMap(format.property(ImageReferenceProperty).toMap()));
    result += QJsonDocument(atom).toJson(QJsonDocument::Compact);
  }
  return result;
}
QByteArray referenceKey(const QJsonObject& reference, int nodeId) {
  return QByteArray::number(nodeId) + ':' + QJsonDocument(reference).toJson(QJsonDocument::Compact);
}
bool replacesBlockStructure(const QTextCursor& cursor, const QString& replacement = QString()) {
  if (replacement.contains(QLatin1Char('\n')) || replacement.contains(QLatin1Char('\r')) ||
      replacement.contains(QChar::ParagraphSeparator)) return true;
  if (!cursor.hasSelection()) return false;
  if (cursor.document()->findBlock(cursor.selectionStart()) != cursor.document()->findBlock(cursor.selectionEnd())) return true;
  for (int position = cursor.selectionStart(); position < cursor.selectionEnd(); ++position) {
    QTextCursor probe(cursor.document()); probe.setPosition(position);
    probe.movePosition(QTextCursor::NextCharacter, QTextCursor::KeepAnchor);
    if (probe.charFormat().boolProperty(ListMarkerProperty)) return true;
  }
  return false;
}

QString referenceMarkdown(const QString& text, const QJsonObject& reference) {
  const QString kind = reference.value("kind").toString();
  const QString head = QLatin1Char('[') + text + QLatin1Char(']');
  if (text == reference.value("textSource").toString()) {
    if (kind == "shortcut") return head;
    if (kind == "collapsed") return head + QStringLiteral("[]");
  }
  return head + QLatin1Char('[') + reference.value("label").toString() + QLatin1Char(']');
}
QString wrapMark(const QString& text, const QString& delimiter) {
  int begin=0,end=text.size();
  while(begin<end && text.at(begin).isSpace()) ++begin;
  while(end>begin && text.at(end-1).isSpace()) --end;
  if(begin==end) return text;
  return text.left(begin)+delimiter+text.mid(begin,end-begin)+delimiter+text.mid(end);
}

QString fenced(QString text, QString language) {
  text.replace(QChar::LineSeparator, QLatin1Char('\n'));
  language.replace(QRegularExpression(QStringLiteral("[\r\n]")), QStringLiteral(" "));
  const QChar ch = language.contains('`') ? QLatin1Char('~') : QLatin1Char('`');
  int length = 3, run = 0;
  for (QChar c : text) { run = c == ch ? run + 1 : 0; length = qMax(length, run + 1); }
  const QString fence(length, ch);
  return fence + (language.startsWith(ch) ? QStringLiteral(" ") : QString()) + language +
         QLatin1Char('\n') + text + (text.isEmpty() || text.endsWith(QLatin1Char('\n')) ? QString() : QStringLiteral("\n")) + fence;
}

QTextCharFormat bodyFormat() {
  QTextCharFormat format;
  format.setFont(theme::uiFont(kBody));
  format.setForeground(theme::text());
  return format;
}

QTextBlockFormat bodyBlock() {
  QTextBlockFormat format;
  // CSS line-height: 1.75 is a multiple of the *font size* (28px at 16px).
  // Qt's proportional height is a percentage of the font metrics instead, which
  // would give ~37px, so the line box is pinned in device pixels.
  format.setLineHeight(28, QTextBlockFormat::FixedHeight);
  format.setTopMargin(16);
  // CSS margins collapse: a 16px top margin already supplies the gap, so the
  // bottom margin is dropped instead of adding 32px between every paragraph.
  format.setBottomMargin(0);
  format.setProperty(RoleProperty, RoleBody);
  return format;
}

qreal chineseFirstLineIndent(const QString& text) {
  // A presentation preference, never characters inserted into Markdown. Any
  // authored visible leading whitespace already supplies its own indentation.
  if (text.isEmpty() || text.front().isSpace()) return 0;
  bool chinese = false;
  for (const QChar ch : text) if (ch.script() == QChar::Script_Han) { chinese = true; break; }
  return chinese ? QFontMetricsF(theme::uiFont(kBody)).horizontalAdvance(QString(2, QChar(0x3000))) : 0;
}

QTextCharFormat mutedFormat() {
  QTextCharFormat format;
  format.setFont(theme::uiFont(kBody));
  format.setForeground(theme::muted());
  return format;
}

// A block image is a painted placeholder only while it is the sole content.
// Once edited, promote a surviving image to a real inline object, or restore a
// normal paragraph after its removal. Call inside the user's undo transaction.
void normalizeBlockImage(QTextCursor& cursor, bool forceInline = false) {
  const QTextBlock block = cursor.block();
  const auto previous = block.blockFormat();
  if (previous.intProperty(RoleProperty) != RoleImage) return;
  bool hasImage = false, hasText = false;
  for (auto it=block.begin();!it.atEnd();++it) {
    const auto fragment=it.fragment();
    if(fragment.charFormat().hasProperty(ImageSourceProperty)) hasImage=true;
    else if(!fragment.text().isEmpty()) hasText=true;
  }
  if(hasImage && !hasText && !forceInline) return;
  struct ImageFragment { int position; int length; QTextCharFormat format; };
  QVector<ImageFragment> images;
  for(auto it=block.begin();!it.atEnd();++it) {
    const auto fragment=it.fragment();
    if(fragment.charFormat().hasProperty(ImageSourceProperty)) images.append({fragment.position(),fragment.length(),fragment.charFormat()});
  }
  for(int i=images.size()-1;i>=0;--i) {
    const auto& image=images.at(i); auto format=image.format;
    format.setFont(theme::uiFont(kBody)); format.setForeground(theme::text());
    format.setObjectType(SafeInlineImageObjectType);
    format.setProperty(ImagePathProperty,previous.stringProperty(ImagePathProperty));
    const qreal height=previous.doubleProperty(ImageHeightProperty);
    const qreal naturalHeight=previous.doubleProperty(ImageHeightProperty);
    format.setProperty(ImageHeightProperty,height);
    format.setProperty(ImageWidthProperty,naturalHeight>0?previous.doubleProperty(ImageWidthProperty)*height/naturalHeight:previous.doubleProperty(ImageWidthProperty));
    QTextCursor replacement(block);replacement.setPosition(image.position);replacement.setPosition(image.position+image.length,QTextCursor::KeepAnchor);
    replacement.insertText(QString(QChar::ObjectReplacementCharacter),format);
  }
  auto format=previous;
  format.setProperty(RoleProperty,RoleBody);
  format.clearProperty(ImagePathProperty);format.clearProperty(ImageWidthProperty);format.clearProperty(ImageHeightProperty);
  format.setLineHeight(28,hasImage ? QTextBlockFormat::MinimumHeight : QTextBlockFormat::FixedHeight);
  QTextCursor change(block);change.setBlockFormat(format);
}

QString runText(const QJsonArray& runs) {
  QString text;
  for (const QJsonValue& value : runs) {
    text += value.toObject().value("text").toString();
  }
  return text;
}

}  // namespace

DocumentView::DocumentView(QWidget* parent) : QAbstractScrollArea(parent) {
  installDocumentAccessibility();
  setFrameShape(QFrame::NoFrame);
  setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  setVerticalScrollBarPolicy(Qt::ScrollBarAsNeeded);
  setFocusPolicy(Qt::StrongFocus);
  setAccessibleName(QStringLiteral("打开"));
  setAccessibleDescription(QStringLiteral("未打开文件。请选择 .md 或 .markdown 文件。"));
  setMouseTracking(true);
  viewport()->setAutoFillBackground(false);
  viewport()->setAttribute(Qt::WA_OpaquePaintEvent, true);

  auto* safeDocument = new SafeImageDocument(this);
  safeDocument->imageLoader = [this](const QUrl& url) -> QVariant {
    const QString path = url.isLocalFile() ? url.toLocalFile() : url.toString();
    return decodedImage(path);
  };
  document_ = safeDocument;
  auto* previewObject = new RawPreviewObject(this);
  previewObject->measure = [this](const QTextFormat& format) {
    const auto surface = rawSurfaces_.value(format.intProperty(RawPreviewOwnerProperty));
    qreal height = 0;
    if (surface.preview) {
      const auto* preview = surface.preview.data();
      height = preview->document()->size().height();
      // QTextDocument measures text, not the extra code surface painted around
      // it. A terminal pre needs its bottom padding inside the child viewport.
      for (QTextBlock block = preview->document()->begin(); block.isValid(); block = block.next()) {
        if (!block.isVisible() || block.blockFormat().intProperty(RoleProperty) != RoleCode) continue;
        const auto bounds = preview->document()->documentLayout()->blockBoundingRect(block);
        height = qMax(height, preview->codeTextBounds(block, bounds).bottom() + 16);
      }
      height += preview->topPadding() + preview->bottomPadding();
    }
    return QSizeF(contentWidth(), qMin<qreal>(20000, qCeil(height)));
  };
  document_->documentLayout()->registerHandler(RawPreviewObjectType, previewObject);
  auto* inlineImage = new RawPreviewObject(this);
  inlineImage->measure = [this](const QTextFormat& format) {
    const QSize size=imageSizes_.value(normalizedImagePath(format.stringProperty(ImagePathProperty)));
    if (format.boolProperty(MissingImageProperty) && !size.isValid()) {
      const QFontMetricsF metrics(theme::uiFont(13));
      const QString label = QStringLiteral("图片缺失：%1").arg(format.stringProperty(ImageSourceProperty));
      return QSizeF(qMin<qreal>(contentWidth(), metrics.horizontalAdvance(label) + 16), metrics.height() + 8);
    }
    if(size.isValid()) { const qreal w=qMin<qreal>(contentWidth(),size.width()); return QSizeF(w,size.height()*w/size.width()); }
    return QSizeF(format.doubleProperty(ImageWidthProperty),format.doubleProperty(ImageHeightProperty));
  };
  inlineImage->paint = [this](QPainter* painter, const QRectF& rect, const QTextFormat& format) {
    const QImage image = decodedImage(format.stringProperty(ImagePathProperty));
    if (format.boolProperty(MissingImageProperty) && image.isNull()) {
      painter->save(); painter->setClipRect(rect, Qt::IntersectClip);
      painter->setRenderHint(QPainter::Antialiasing, true);
      painter->setPen(Qt::NoPen); painter->setBrush(theme::dangerBg());
      painter->drawRoundedRect(rect, kRadiusContent, kRadiusContent);
      painter->setFont(theme::uiFont(13)); painter->setPen(theme::danger());
      painter->drawText(rect.adjusted(8, 4, -8, -4), Qt::AlignVCenter | Qt::TextSingleLine,
                        QStringLiteral("图片缺失：%1").arg(format.stringProperty(ImageSourceProperty)));
      painter->restore(); return;
    }
    if (image.isNull()) return;
    painter->save();
    QPainterPath clip; clip.addRoundedRect(rect, kRadiusContent, kRadiusContent);
    painter->setClipPath(clip, Qt::IntersectClip);
    painter->setRenderHint(QPainter::SmoothPixmapTransform, true);
    painter->drawImage(rect, image); painter->restore();
  };
  document_->documentLayout()->registerHandler(SafeInlineImageObjectType, inlineImage);
  auto* blockImage=new RawPreviewObject(this);
  blockImage->measure=inlineImage->measure;
  document_->documentLayout()->registerHandler(BlockImageObjectType,blockImage);
  document_->setDocumentMargin(0);
  document_->setDefaultFont(theme::uiFont(kBody));
  new CodeSyntaxHighlighter(document_);
  document_->setUndoRedoEnabled(true);

  setAttribute(Qt::WA_InputMethodEnabled, true);
  caretTimer_ = new QTimer(this);
  caretTimer_->setInterval(530);
  connect(caretTimer_, &QTimer::timeout, this, [this] {
    caretOn_ = !caretOn_;
    viewport()->update();
  });

  connect(document_, &QTextDocument::contentsChange, this, [this](int position, int removed, int added) {
    if (building_ || empty_ || suppressEdits_) return;
    if (removed == 0 && added == 0) return;
    // Track deleted ownership before advancing cached positions. Normal text
    // edits retain QTextBlock handles, so their indexes need no whole-doc rebuild.
    int changedIndex = -1, touched = 0;
    for (int index=0;index<blockSnapshot_.size();++index) {
      const auto& old=blockSnapshot_[index];
      if(old.end>=position && old.start<=position+removed) {
        if(old.segment>=0)dirtySegments_.insert(old.segment);
        changedIndex=index;++touched;
      }
    }
    const QTextBlock changed=document_->findBlock(position);
    const auto format=changed.blockFormat();
    const int node=format.hasProperty(NodeProperty)?format.intProperty(NodeProperty):-1;
    const int role=format.intProperty(RoleProperty);
    const bool sameBlock=touched==1 && changedIndex>=0 && document_->blockCount()==blockSnapshot_.size() &&
      changed==document_->findBlock(position+added) && segmentOf(changed)==blockSnapshot_[changedIndex].segment &&
      node==blockSnapshot_[changedIndex].node && role==blockSnapshot_[changedIndex].role &&
      removed<blockSnapshot_[changedIndex].end-blockSnapshot_[changedIndex].start+1;
    if(segmentOf(changed)>=0)dirtySegments_.insert(segmentOf(changed));
    const bool fast=sameBlock && blockRectCache_.contains(changed.blockNumber()) &&
      (role==RoleBody || role==RoleHeading || role==RoleListItem || role==RoleTable || (role==RoleCode && !format.boolProperty(RawProperty)));
    if(!fast || (pendingGeometryBlock_.isValid() && pendingGeometryBlock_!=changed))fullGeometryPending_=true;
    else pendingGeometryBlock_=changed;
    if(sameBlock) {
      const int delta=added-removed;
      blockSnapshot_[changedIndex].end+=delta;
      for(int i=changedIndex+1;i<blockSnapshot_.size();++i){blockSnapshot_[i].start+=delta;blockSnapshot_[i].end+=delta;}
      for(auto& region:horizontalRegions_)if(region.blockPosition>position)region.blockPosition+=delta;
    } else snapshotBlocks();
    emit contentEdited();
    if (!layoutQueued_) {
      layoutQueued_ = true;
      QTimer::singleShot(0, this, [this] { layoutQueued_ = false; refreshAfterEdit(); });
    }
  });

  QPalette pal = theme::selectionPalette(palette());
  setPalette(pal);

  setStyleSheet(QStringLiteral(
      "QScrollBar:vertical { width: 10px; background: transparent; margin: 0; border: 0; }"
      "QScrollBar::handle:vertical { margin: 0 1px 0 5px; background: rgba(11,11,11,0.20);"
      " border-radius: 2px; min-height: 40px; }"
      "QScrollBar::handle:vertical:hover { background: rgba(11,11,11,0.35); }"
      "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }"
      "QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }"));

  connect(verticalScrollBar(), &QScrollBar::valueChanged, this, [this] {
    viewport()->update(); layoutRawSurfaces(); emit viewportChanged();
  });
}

int DocumentView::contentWidth() const {
  if (previewMode_) return qMax(160, viewport()->width());
  const int available = qMin(theme::documentMaxWidth(), viewport()->width());
  const int padding = width() < 760 ? 20 : theme::documentPaddingInline();
  return qMax(160, available - padding * 2);
}

int DocumentView::contentLeft() const {
  if (previewMode_) return 0;
  const int padding = width() < 760 ? 20 : theme::documentPaddingInline();
  return qMax(padding, (viewport()->width() - contentWidth()) / 2);
}

QPointF DocumentView::toDocument(const QPoint& viewportPosition) const {
  return QPointF(viewportPosition.x() - contentLeft(),
                 viewportPosition.y() + verticalScrollBar()->value() - topPadding());
}

void DocumentView::setEmptyState() {
  stopHeadingScroll();
  resetCodeCopyFeedback();
  // Closing a document is a lifecycle boundary, not an editing operation.
  // Release its model and working storage rather than retaining a hidden draft.
  building_=true;empty_=true;errorMessage_.clear();
  setAccessibleName(QStringLiteral("打开"));
  setAccessibleDescription(QStringLiteral("未打开文件。请选择 .md 或 .markdown 文件。"));
  imageCache_.clear();animationCache_.clear();authorizedImages_.clear();imageSources_.clear();imageSizes_.clear();paintedImages_.clear();
  for(auto& surface:rawSurfaces_){delete surface.preview;}rawSurfaces_.clear();
  auto release=[](auto& values){using Values=std::decay_t<decltype(values)>;Values{}.swap(values);};
  release(codeBoxes_);release(quoteBars_);release(ruleLines_);release(imageBoxes_);release(tableBoxes_);release(inlineBoxes_);release(tableRefs_);release(paintedTables_);release(horizontalRegions_);release(blockSnapshot_);release(matches_);
  originalReferenceFingerprints_.clear();
  modelTree_=QJsonArray();baselineSegments_.clear();segmentModels_.clear();nodeBlocks_.clear();segmentBlocks_.clear();blockRectCache_.clear();horizontalOffsets_.clear();editableSegments_.clear();dirtySegments_.clear();
  documentPath_.clear();previewContext_.clear();query_.clear();preedit_.clear();matchCount_=0;activeMatch_=-1;copiedNode_=-1;draggingRegion_=-1;draggingTable_=-1;dragging_=false;typingContinuation_=false;
  pendingGeometryBlock_=QTextBlock();fullGeometryPending_=false;cachedDocumentHeight_=0;
  document_->setUndoRedoEnabled(false);document_->clear();document_->setUndoRedoEnabled(true);cursor_=QTextCursor(document_);
  building_=false;updateScrollRange();viewport()->update();
}

void DocumentView::setErrorState(const QString& message) {
  setEmptyState();errorMessage_=message;setAccessibleName(QStringLiteral("重新选择"));setAccessibleDescription(QStringLiteral("打开失败。")+message);viewport()->update();
}

void DocumentView::setPlan(const QJsonObject& plan, const QString& documentPath) {
  clearPreeditLayout(); preedit_.clear();
  stopHeadingScroll();
  resetCodeCopyFeedback();
  errorMessage_.clear();
  setAccessibleName(QStringLiteral("文档编辑器"));setAccessibleDescription(QString());
  authorizedImages_.clear(); imageSources_.clear(); imageSizes_.clear(); imageCache_.clear(); animationCache_.clear();
  if(normalizedImagePath(documentPath_)!=normalizedImagePath(documentPath)) {
    // A different file owns a different working set. Keep same-file reparses
    // reusable, but do not carry the previous file's peak vector capacities.
    auto release=[](auto& values){using Values=std::decay_t<decltype(values)>;Values{}.swap(values);};
    release(codeBoxes_);release(quoteBars_);release(ruleLines_);release(imageBoxes_);release(tableBoxes_);release(inlineBoxes_);release(tableRefs_);release(paintedTables_);release(horizontalRegions_);release(blockSnapshot_);release(matches_);
    matchCount_=0;activeMatch_=-1;
  }
  documentPath_ = documentPath;
  previewContext_.clear();
  for (const auto& block : plan.value("blocks").toArray()) previewContext_ += block.toObject().value("source").toString();
  typingContinuation_ = false;
  cachedDocumentHeight_=-1; pendingGeometryBlock_=QTextBlock(); fullGeometryPending_=false;
  horizontalOffsets_.clear();
  horizontalRegions_.clear();
  empty_ = false;
  building_ = true;
  editableSegments_.clear();
  dirtySegments_.clear();
  baselineSegments_.clear(); segmentModels_.clear();
  document_->setLayoutEnabled(false);
  document_->setUndoRedoEnabled(false);
  buildDocument(plan);
  originalReferenceFingerprints_.clear();
  for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
    for (auto it = block.begin(); !it.atEnd(); ++it) {
      const auto fragment = it.fragment(); if (!fragment.isValid()) continue;
      const auto format = fragment.charFormat();
      const auto reference = QJsonObject::fromVariantMap(format.property(LinkReferenceProperty).toMap());
      if (format.isAnchor() && !reference.isEmpty() && !format.boolProperty(ListMarkerProperty))
        originalReferenceFingerprints_[referenceKey(reference, block.blockFormat().intProperty(NodeProperty))] += referenceFingerprint(fragment.text(), format);
    }
  }
  for (auto& fingerprint : originalReferenceFingerprints_)
    fingerprint = QCryptographicHash::hash(fingerprint, QCryptographicHash::Sha256);
  snapshotBlocks();
  for (const auto& value : modelTree_) {
    const auto node=value.toObject(); segmentModels_.insert(node.value("segment").toInt(-1),node);
  }
  for (const QJsonValue& value : modelTree_) {
    const int segment = value.toObject().value("segment").toInt(-1);
    if (segment >= 0) baselineSegments_.insert(segment, serializeSegment(segment));
  }
  document_->setTextWidth(contentWidth());
  for(auto* highlighter:document_->findChildren<QSyntaxHighlighter*>())highlighter->rehighlight();
  document_->setUndoRedoEnabled(true);
  document_->setLayoutEnabled(true);
  document_->clearUndoRedoStacks();
  building_ = false;
  cursor_ = QTextCursor(document_);
  cursor_.movePosition(QTextCursor::NextBlock);
  relayout();
  verticalScrollBar()->setValue(0);
  if (!query_.isEmpty()) applySearchHighlight(query_);
}

void DocumentView::buildDocument(const QJsonObject& plan) {
  taskListPreview_ = previewMode_ && plan.value("taskListWhitespace").toBool();
  for (auto& surface : rawSurfaces_) { delete surface.preview; }
  rawSurfaces_.clear();
  document_->clear();
  tableRefs_.clear();
  paintedTables_.clear();

  QTextCursor cursor(document_);
  cursor.beginEditBlock();

  int nextNode = 0;
  std::function<QJsonArray(const QJsonArray&)> annotate;
  annotate = [&](const QJsonArray& input) {
    QJsonArray result;
    for (const auto& value : input) {
      QJsonObject node = value.toObject();
      node.insert("nodeId", nextNode++);
      if (node.contains("blocks")) node.insert("blocks", annotate(node.value("blocks").toArray()));
      if (node.contains("items")) {
        QJsonArray items;
        for (const auto& item : node.value("items").toArray()) {
          QJsonArray children = item.toArray();
          // Empty items are real editable paragraphs, not absent children.
          if (children.isEmpty()) children.append(QJsonObject{{"type", "paragraph"}, {"runs", QJsonArray()}});
          items.append(annotate(children));
        }
        node.insert("items", items);
      }
      result.append(node);
    }
    return result;
  };
  modelTree_ = annotate(plan.value("blocks").toArray());
  const QJsonArray blocks = modelTree_;
  int currentNode = -1;
  int quoteDepth = 0;
  QVariantList quoteListInsets;
  int currentListDepth = -1;

  // Qt drops the top margin of the very first block. A zero-height leading block
  // keeps every content block able to carry its own margin (the reading view's
  // 32px heading rhythm and the 16px code/table padding depend on it).
  {
    QTextBlockFormat zero;
    zero.setTopMargin(0);
    zero.setBottomMargin(0);
    zero.setLineHeight(0, QTextBlockFormat::FixedHeight);
    cursor.setBlockFormat(zero);
    QTextCharFormat invisible;
    invisible.setFont(theme::uiFont(1));
    invisible.setForeground(Qt::transparent);
    cursor.insertText(QString(QChar(0x200B)), invisible);
  }

  bool firstContent = true;
  int hiddenInsertionNode = -1, hiddenInsertionSegment = -1;
  bool afterTable = false;
  qreal pendingInnerBottomPadding = 0;

  auto openBlock = [&](QTextBlockFormat format, int segment) {
    // Inner padding must not collapse with the next sibling's outer margin.
    // QTextBlock margins alone cannot represent both sides of that boundary.
    format.setTopMargin(format.topMargin() + pendingInnerBottomPadding);
    pendingInnerBottomPadding = 0;
    if (segment >= 0) format.setProperty(SegmentProperty, segment);
    format.setProperty(NodeProperty, currentNode);
    if (currentListDepth >= 0) {
      format.setProperty(ListDepthProperty, currentListDepth);
      format.setLeftMargin(format.leftMargin() + 24 * (currentListDepth + 1));
    }
    format.setProperty(QuoteDepthProperty, quoteDepth);
    format.setProperty(QuoteListInsetsProperty, quoteListInsets);
    if (quoteDepth > 0) format.setLeftMargin(format.leftMargin() + quoteDepth * 18);
    if (afterTable) {
      cursor.setBlockFormat(format);
      afterTable = false;
    } else {
      cursor.insertBlock(format);
    }
    // The block's own character format is used when its last character is
    // removed. Reset it explicitly: insertBlock(format) otherwise inherits the
    // preceding heading/code/hidden spacer, even though inserted runs look right.
    const auto base = quoteDepth > 0 ? mutedFormat() : bodyFormat();
    cursor.setBlockCharFormat(base);
    cursor.setCharFormat(base);
    firstContent = false;
  };

  std::function<void(QTextCursor&, const QJsonArray&, const QTextCharFormat&)> insertRuns;
  insertRuns = [&](QTextCursor& into, const QJsonArray& runs, const QTextCharFormat& base) {
    for (const QJsonValue& value : runs) {
      const QJsonObject run = value.toObject();
      const QString kind = run.value("kind").toString();

      if (kind == QStringLiteral("hardBreak") || kind == QStringLiteral("softBreak")) {
        QTextCharFormat breakFormat = base;
        if (kind == QStringLiteral("softBreak")) breakFormat.setProperty(SoftBreakProperty, true);
        applyRunMarks(breakFormat, run);
        into.insertText(QString(QChar::LineSeparator), breakFormat);
        continue;
      }
      if (kind == QStringLiteral("image")) {
        // Fixed text leading makes tall inline objects rise over earlier lines.
        // Keep the paragraph's normal rhythm as a minimum, not an object cap.
        auto imageBlock = into.blockFormat();
        if (imageBlock.lineHeightType() == QTextBlockFormat::FixedHeight) {
          imageBlock.setLineHeight(imageBlock.lineHeight(), QTextBlockFormat::MinimumHeight);
          into.setBlockFormat(imageBlock);
        }
        const QJsonObject resolved = bridge::resolveImage(documentPath_, run.value("src").toString());
        if (resolved.value("ok").toBool()) {
          const QString path = resolved.value("path").toString();
          const auto data = bridge::readImage(documentPath_, run.value("src").toString());
          const QByteArray url = data.value("dataUrl").toString().toLatin1();
          QBuffer buffer; buffer.setData(imageDecode::inputBytes(QByteArray::fromBase64(url.mid(url.indexOf(',')+1)))); buffer.open(QIODevice::ReadOnly);
          QImageReader reader(&buffer);
          const QSize imageSize = data.value("ok").toBool() ? reader.size() : QSize();
          if (imageSize.isValid()) {
            authorizedImages_.insert(normalizedImagePath(path));
            imageSources_.insert(normalizedImagePath(path),run.value("src").toString());
            imageSizes_.insert(normalizedImagePath(path),imageSize);
            QTextImageFormat imageFormat;
            imageFormat.setName(resolved.value("path").toString());
            const qreal width = qMin(imageSize.width(), contentWidth());
            imageFormat.setWidth(width);
            imageFormat.setHeight(imageSize.height() * width / imageSize.width());
            imageFormat.setProperty(ImageSourceProperty, run.value("src").toString());
            imageFormat.setProperty(ImageAltProperty, run.value("alt").toString());
            imageFormat.setProperty(ImageTitleProperty, run.value("title").toString());
            applyRunMarks(imageFormat, run);
            imageFormat.setObjectType(SafeInlineImageObjectType);
            imageFormat.setProperty(ImagePathProperty, path);
            imageFormat.setProperty(ImageWidthProperty, imageFormat.width());
            imageFormat.setProperty(ImageHeightProperty, imageFormat.height());
            into.insertText(QString(QChar::ObjectReplacementCharacter), imageFormat);
            continue;
          }
        }
        QTextCharFormat alt = base;
        alt.setProperty(ImageSourceProperty, run.value("src").toString());
        alt.setProperty(ImageAltProperty, run.value("alt").toString());
        alt.setProperty(ImageTitleProperty, run.value("title").toString());
        alt.setFont(theme::uiFont(13));
        alt.setForeground(theme::danger());
        applyRunMarks(alt, run);
        alt.setObjectType(SafeInlineImageObjectType);
        alt.setProperty(MissingImageProperty, true);
        // A cache identity only, never a filesystem path. Every retry still
        // passes the original source to bridge::readImage's authorization.
        const QString key = normalizedImagePath(QStringLiteral("missing-image:") + run.value("src").toString());
        alt.setProperty(ImagePathProperty, key);
        authorizedImages_.insert(key); imageSources_.insert(key, run.value("src").toString());
        // The UI label is painted only: one image occupies one cursor position,
        // exactly like a successfully decoded image, including IME and search.
        into.insertText(QString(QChar::ObjectReplacementCharacter), alt);
        continue;
      }

      if (kind == QStringLiteral("code")) {
        QTextCharFormat code;
        code.setFont(theme::monoFont(kCode));
        code.setForeground(theme::text());
        code.setProperty(InlineCodeProperty, true);
        if (base.fontWeight() >= QFont::DemiBold) code.setFontWeight(QFont::DemiBold);
        if (run.value("bold").toBool()) code.setProperty(MarkBoldProperty, true);
        if (run.value("italic").toBool()) {
          code.setFontItalic(true);
          code.setProperty(MarkItalicProperty, true);
        }
        if (run.value("strike").toBool()) {
          code.setFontStrikeOut(true);
          code.setProperty(MarkStrikeProperty, true);
        }
        const QJsonObject link = run.value("link").toObject();
        if (!link.isEmpty()) {
          code.setAnchor(true);
          code.setAnchorHref(link.value("href").toString());
          code.setProperty(LinkTitleProperty, link.value("title").toString());
          code.setForeground(theme::accent());
        }
        applyRunMarks(code, run);
        into.insertText(run.value("text").toString(), code);
        continue;
      }

      QTextCharFormat format = base;
      const bool bold = run.value("bold").toBool();
      const bool italic = run.value("italic").toBool();
      const bool strike = run.value("strike").toBool();
      if (bold) {
        format.setFontWeight(QFont::DemiBold);
        format.setProperty(MarkBoldProperty, true);
      }
      if (italic) {
        format.setFontItalic(true);
        format.setProperty(MarkItalicProperty, true);
      }
      if (strike) {
        format.setFontStrikeOut(true);
        format.setProperty(MarkStrikeProperty, true);
      }
      const QJsonObject link = run.value("link").toObject();
      if (!link.isEmpty()) {
        format.setAnchor(true);
        format.setAnchorHref(link.value("href").toString());
        format.setProperty(LinkTitleProperty, link.value("title").toString());
        if (link.value("reference").isObject()) format.setProperty(LinkReferenceProperty,link.value("reference").toObject().toVariantMap());
        format.setForeground(theme::accent());
        format.setFontUnderline(true);
        format.setUnderlineColor(QColor("#86b6ef"));
      }
      into.insertText(run.value("text").toString(), format);
    }
  };

  auto collectRuns = [](const QJsonArray& runs, bool bold) {
    QVector<TableRun> out;
    for (const QJsonValue& value : runs) {
      const QJsonObject run = value.toObject();
      const QString kind = run.value("kind").toString();
      TableRun item;
      item.bold = bold || run.value("bold").toBool();
      item.italic = run.value("italic").toBool();
      item.strike = run.value("strike").toBool();
      if (kind == QStringLiteral("hardBreak") || kind == QStringLiteral("softBreak")) {
        item.text = QStringLiteral(" ");
      } else if (kind == QStringLiteral("image")) {
        item.text = QStringLiteral("[图片] ") + run.value("alt").toString();
      } else {
        item.text = run.value("text").toString();
        item.code = kind == QStringLiteral("code");
      }
      item.href = run.value("link").toObject().value("href").toString();
      out.append(item);
    }
    return out;
  };

  std::function<void(const QJsonArray&, int, int)> insertBlocks;
  insertBlocks = [&](const QJsonArray& list, int depth, int inheritedSegment) {
    if (depth > 16) return;

    for (const QJsonValue& value : list) {
      const QJsonObject block = value.toObject();
      const QString type = block.value("type").toString();
      currentNode = block.value("nodeId").toInt(-1);
      currentListDepth = depth - 1;
      const int segment = block.value("segment").toInt(inheritedSegment);
      if (type == "raw" && block.value("hidden").toBool()) {
        hiddenInsertionNode = currentNode; hiddenInsertionSegment = segment;
        continue;
      }
      const bool editableBlock = type == QStringLiteral("paragraph") ||
                                 type == QStringLiteral("heading") ||
                                 type == QStringLiteral("code") ||
                                 type == QStringLiteral("list") ||
                                 type == QStringLiteral("quote") ||
                                 type == QStringLiteral("table") || type == QStringLiteral("raw") || type == QStringLiteral("hr");
      if (editableBlock && segment >= 0) editableSegments_.insert(segment);

      if (type == QStringLiteral("paragraph")) {
        const QJsonArray runs = block.value("runs").toArray();

        // A paragraph holding a single image becomes a block image so it can be
        // painted with the stylesheet's 6px rounding and full content width.
        if (runs.size() == 1 && runs.first().toObject().value("kind").toString() == QStringLiteral("image")) {
          const QJsonObject run = runs.first().toObject();
          const QJsonObject resolved = bridge::resolveImage(documentPath_, run.value("src").toString());
          const QString path = resolved.value("ok").toBool() ? resolved.value("path").toString() : QString();
          const auto data = bridge::readImage(documentPath_, run.value("src").toString());
          const QByteArray url = data.value("dataUrl").toString().toLatin1();
          QBuffer buffer; buffer.setData(imageDecode::inputBytes(QByteArray::fromBase64(url.mid(url.indexOf(',')+1)))); buffer.open(QIODevice::ReadOnly);
          QImageReader reader(&buffer);
          const QSize imageSize = path.isEmpty() || !data.value("ok").toBool() ? QSize() : reader.size();
          if (imageSize.isValid()) {
            authorizedImages_.insert(normalizedImagePath(path));
            imageSources_.insert(normalizedImagePath(path),run.value("src").toString());
            imageSizes_.insert(normalizedImagePath(path),imageSize);
            QTextBlockFormat format = bodyBlock();
            format.setTopMargin(firstContent ? 0 : 16);
            format.setProperty(RoleProperty, RoleImage);
            format.setProperty(ImagePathProperty, resolved.value("path").toString());
            format.setProperty(ImageWidthProperty, imageSize.width());
            format.setProperty(ImageHeightProperty, imageSize.height());
            format.setLineHeight(100, QTextBlockFormat::ProportionalHeight);
            openBlock(format, segment);
            QTextCharFormat spacer;
            spacer.setFont(theme::uiFont(1));
            spacer.setForeground(Qt::transparent);
            spacer.setObjectType(BlockImageObjectType);
            spacer.setProperty(ImagePathProperty,path);
            spacer.setProperty(ImageWidthProperty,imageSize.width());
            spacer.setProperty(ImageHeightProperty,imageSize.height());
            spacer.setProperty(ImageSourceProperty, run.value("src").toString());
            spacer.setProperty(ImageAltProperty, run.value("alt").toString());
            spacer.setProperty(ImageTitleProperty, run.value("title").toString());
            applyRunMarks(spacer, run);
            cursor.insertText(QString(QChar::ObjectReplacementCharacter), spacer);
            continue;
          }
        }

        QTextBlockFormat format = bodyBlock();
        format.setTopMargin(firstContent ? 0 : 16);
        if (!previewMode_ && depth == 0 && quoteDepth == 0)
          format.setTextIndent(chineseFirstLineIndent(runText(runs)));
        openBlock(format, segment);
        insertRuns(cursor, runs, quoteDepth > 0 ? mutedFormat() : bodyFormat());
        continue;
      }

      if (type == QStringLiteral("heading")) {
        const int level = block.value("level").toInt(1);
        const int size = level == 1 ? 30 : level == 2 ? 24 : level == 3 ? 20 : level == 4 ? 18 : 16;
        QTextBlockFormat format = bodyBlock();
        format.setTopMargin(firstContent ? 0 : 32);
        format.setLineHeight(size * 1.3, QTextBlockFormat::FixedHeight);
        format.setProperty(RoleProperty, RoleHeading);
        format.setProperty(HeadingLevelProperty, level);
        openBlock(format, segment);
        QTextCharFormat heading;
        heading.setFont(theme::uiFont(size, QFont::DemiBold));
        heading.setForeground(theme::text());
        cursor.setBlockCharFormat(heading);
        insertRuns(cursor, block.value("runs").toArray(), heading);
        continue;
      }

      if (type == QStringLiteral("code") || type == QStringLiteral("raw")) {
        const bool raw = type == QStringLiteral("raw");
        QTextBlockFormat format = bodyBlock();
        // 16px padding above/below plus the stylesheet's 16px margin.
        format.setTopMargin(firstContent ? 16 : 32);
        format.setBottomMargin(16);
        format.setLeftMargin(16);
        format.setRightMargin(16);
        // CSS pre inherits 16px and line-height:1.6; its 14px code child does
        // not reduce that 25.6px line box. Raw source is a separate surface.
        format.setLineHeight(raw ? 22.4 : 25.6, raw ? QTextBlockFormat::MinimumHeight : QTextBlockFormat::FixedHeight);
        format.setProperty(RoleProperty, RoleCode);
        format.setNonBreakableLines(true);
        format.setProperty(RawProperty, raw);
        if (!raw) format.setProperty(CodeLanguageProperty, block.value("language").toString());
        openBlock(format, segment);
        QTextCharFormat code;
        code.setFont(theme::monoFont(raw ? 13 : kCode));
        code.setForeground(raw ? theme::muted() : theme::text());
        cursor.setBlockCharFormat(code);
        if (raw && !previewMode_ && !block.value("preview").toObject().value("blocks").toArray().isEmpty()) {
          RawSurface surface; surface.node = currentNode;
          surface.preview = new DocumentView(viewport());
          surface.preview->previewMode_ = true; surface.preview->readOnly_ = true;
          surface.preview->resize(contentWidth(), 400);
          surface.plan = withTaskListSpacing(block.value("preview").toObject(), block.value("text").toString());
          surface.preview->setPlan(surface.plan, documentPath_);
          connect(surface.preview, &DocumentView::linkActivated, this, &DocumentView::linkActivated);
          connect(surface.preview, &DocumentView::sourceEditRequested, this, [this, node=currentNode] {
            setRawSourceVisible(node, true);
            ensureCaretVisible();
          });
          connect(surface.preview, &DocumentView::viewportChanged, this, &DocumentView::viewportChanged);
          rawSurfaces_.insert(currentNode, surface);
        }
        QString codeText=block.value("text").toString();
        if(!raw && codeText.endsWith(QLatin1Char('\n')))codeText.chop(1);
        const QStringList lines = codeText.split(QLatin1Char('\n'));
        for (int index = 0; index < lines.size(); ++index) {
          if (index > 0) cursor.insertText(QString(QChar::LineSeparator), code);
          cursor.insertText(lines.at(index), code);
        }
        if (raw && rawSurfaces_.contains(currentNode)) {
          QTextBlock sourceBlock = cursor.block();
          QTextBlockFormat placeholder = bodyBlock();
          // The inline preview object owns its measured height. A fixed body
          // line clips tall previews and lets their child widget cover the next block.
          placeholder.setLineHeight(1, QTextBlockFormat::MinimumHeight);
          // openBlock already consumed the preceding surface's inner padding.
          // Carry that spacing to the visible placeholder, removing only this
          // raw source block's own top padding (the preview paints its own).
          placeholder.setTopMargin(qMax<qreal>(0, sourceBlock.blockFormat().topMargin() - 16));
          placeholder.setBottomMargin(16);
          placeholder.setProperty(RawPreviewOwnerProperty, currentNode);
          cursor.insertBlock(placeholder, bodyFormat());
          QTextCharFormat object;
          object.setObjectType(RawPreviewObjectType);
          object.setProperty(RawPreviewOwnerProperty, currentNode);
          cursor.insertText(QString(QChar::ObjectReplacementCharacter), object);
          sourceBlock.setVisible(false); sourceBlock.setLineCount(0);
        }
        pendingInnerBottomPadding = raw && rawSurfaces_.contains(currentNode) ? 0 : 16;
        continue;
      }

      if (type == QStringLiteral("quote")) {
        ++quoteDepth;
        // Lists entered later live inside this quote and must not move its rule.
        quoteListInsets.append(24 * depth);
        insertBlocks(block.value("blocks").toArray(), depth, segment);
        quoteListInsets.removeLast();
        --quoteDepth;
        // CSS blockquote contributes 0.2em padding on each side, in addition
        // to the collapsed paragraph margin. Keep that space out of the text.
        pendingInnerBottomPadding += 6.4;
        continue;
      }

      if (type == QStringLiteral("list")) {
        const bool ordered = block.value("ordered").toBool();
        const int start = block.value("start").toInt(1);
        const QJsonArray items = block.value("items").toArray();
        const QJsonArray tasks = block.value("tasks").toArray();
        for (int index = 0; index < items.size(); ++index) {
          const int before = cursor.position();
          insertBlocks(items.at(index).toArray(), depth + 1, segment);
          QTextBlock first = document_->findBlock(before).next();
          if (!first.isValid()) continue;
          QTextCursor item(first);
          QTextBlockFormat format = first.blockFormat();
          format.setTopMargin(depth > 0 ? 4 : (index == 0 ? format.topMargin() : 4));
          format.setLeftMargin(24 * (depth + 1) + quoteDepth * 18);
          format.setProperty(ListOrderedProperty, ordered);
          format.setProperty(ListNumberProperty, start + index);
          format.setProperty(ListDepthProperty, depth);
          format.setProperty(ListDelimiterProperty, block.value("delimiter").toString(QStringLiteral(".")));
          format.setProperty(ListLooseProperty, block.value("loose").toBool());
          const bool task = index < tasks.size() && tasks.at(index).isBool();
          if (task) format.setProperty(TaskCheckedProperty, tasks.at(index).toBool());
          if (format.intProperty(RoleProperty) == RoleBody) format.setProperty(RoleProperty, RoleListItem);
          const QString marker = task ? (tasks.at(index).toBool() ? QStringLiteral("\u2611  ") : QStringLiteral("\u2610  ")) :
              ordered ? QStringLiteral("%1. ").arg(start + index) : (depth > 0 ? QStringLiteral("\u25e6  ") : QStringLiteral("\u2022  "));
          format.setTextIndent(-QFontMetricsF(theme::uiFont(kBody)).horizontalAdvance(marker));
          item.setBlockFormat(format);
          QTextCharFormat markerFormat = bodyFormat();
          markerFormat.setProperty(ListMarkerProperty, true);
          item.insertText(marker, markerFormat);
        }
        continue;
      }

      if (type == QStringLiteral("table")) {
        QJsonArray header = block.value("header").toArray();
        QJsonArray rows = block.value("rows").toArray();
        struct Span { int row; int column; int rows; int columns; };
        QVector<Span> spans;
        const QJsonArray spanRows = block.value("spans").toArray();
        const QJsonArray headerRows = block.value("cellHeaders").toArray();
        QHash<QPair<int, int>, QJsonObject> cellHeaders;
        bool oversizedSpans = false;
        qint64 spanCells = 0;
        for (const auto& spanRow : spanRows) for (const auto& value : spanRow.toArray()) {
          const auto span = value.toObject();
          const int width = qMax(1, span.value("colspan").toInt(1));
          const int height = qMax(1, span.value("rowspan").toInt(1));
          spanCells += qint64(width) * height;
          if (width > 256 || height > 256 || spanCells > 10000) oversizedSpans = true;
        }
        if (oversizedSpans || (!spanRows.isEmpty() && rows.size() > 255)) {
          openBlock(bodyBlock(), segment);
          cursor.insertText(QStringLiteral("表格过大，请切换源码查看。"), mutedFormat());
          continue;
        }
        if (!spanRows.isEmpty()) {
          QJsonArray original; original.append(header);
          for (const auto& row : rows) original.append(row);
          QVector<QVector<QJsonArray>> grid;
          QSet<QPair<int, int>> occupied;
          int columnCount = 0;
          for (int row = 0; row < original.size() && row < 256; ++row) {
            const QJsonArray cells = original.at(row).toArray();
            const QJsonArray sizes = row < spanRows.size() ? spanRows.at(row).toArray() : QJsonArray();
            const QJsonArray headers = row < headerRows.size() ? headerRows.at(row).toArray() : QJsonArray();
            int column = 0;
            for (int cell = 0; cell < cells.size() && column < 256; ++cell) {
              while (occupied.contains({row, column}) && column < 256) ++column;
              if (column >= 256) break;
              const QJsonObject size = cell < sizes.size() ? sizes.at(cell).toObject() : QJsonObject();
              const int height = qBound(1, size.value("rowspan").toInt(1), 256 - row);
              const int width = qBound(1, size.value("colspan").toInt(1), qMax(1, 256 - column));
              if (qint64(row + height) * (column + width) > 10000) break;
              if (grid.size() < row + height) grid.resize(row + height);
              for (int r = row; r < row + height; ++r) {
                if (grid[r].size() < column + width) grid[r].resize(column + width);
                for (int c = column; c < column + width; ++c) occupied.insert({r, c});
              }
              grid[row][column] = cells.at(cell).toArray();
              if (cell < headers.size()) cellHeaders.insert({row, column}, headers.at(cell).toObject());
              spans.append({row, column, height, width});
              column += width; columnCount = qMax(columnCount, column);
            }
          }
          rows = QJsonArray();
          for (int row = 0; row < grid.size(); ++row) {
            QJsonArray cells;
            for (int col = 0; col < columnCount; ++col) cells.append(col < grid[row].size() ? grid[row][col] : QJsonArray());
            if (row == 0) header = cells; else rows.append(cells);
          }
        }
        const int columns = qMax(1, header.size());

        QFontMetricsF bodyMetrics(theme::uiFont(kBody));
        QFontMetricsF boldMetrics(theme::uiFont(kBody, QFont::Bold));
        QVector<qreal> natural(columns, 96.0);  // stylesheet min-width: 96px
        auto measure = [&](const QJsonArray& cells) {
          for (int column = 0; column < cells.size() && column < columns; ++column) {
            const QString text = runText(cells.at(column).toArray());
            const qreal width = (column < header.size() ? boldMetrics : bodyMetrics)
                                    .horizontalAdvance(text) + 20;  // 10px padding each side
            natural[column] = qMax(natural[column], width);
          }
        };
        measure(header);
        for (const QJsonValue& row : rows) measure(row.toArray());

        qreal total = 0;
        for (qreal width : natural) total += width;
        const qreal available = contentWidth();

        if (false && total > available + 0.5) {
          // The stylesheet caps the table at the reading width and scrolls it
          // horizontally; Qt clamps negative block margins, so the table is
          // reserved by a spacer block and painted with its own scroll state.
          PaintedTable painted;
          painted.columns = natural;
          painted.columnWidth = available;
          painted.maxScroll = total - available;
          QVector<QVector<TableRun>> headerRow;
          for (int column = 0; column < columns; ++column) {
            headerRow.append(collectRuns(header.at(column).toArray(), true));
          }
          painted.cells.append(headerRow);
          for (const QJsonValue& rowValue : rows) {
            const QJsonArray cells = rowValue.toArray();
            QVector<QVector<TableRun>> rowCells;
            for (int column = 0; column < columns; ++column) {
              rowCells.append(collectRuns(column < cells.size() ? cells.at(column).toArray() : QJsonArray(), false));
            }
            painted.cells.append(rowCells);
          }

          const qreal bodyHeight = painted.cells.size() * 40.0;
          QTextBlockFormat format = bodyBlock();
          format.setTopMargin(firstContent ? 0 : 16);
          format.setBottomMargin(0);
          openBlock(format, segment);
          painted.blockPosition = cursor.block().position();
          QTextBlockFormat spacer = cursor.blockFormat();
          spacer.setLineHeight(bodyHeight + 12, QTextBlockFormat::FixedHeight);
          cursor.setBlockFormat(spacer);
          QTextCharFormat invisible;
          invisible.setFont(theme::uiFont(1));
          invisible.setForeground(Qt::transparent);
          cursor.insertText(QString(QChar(0x200B)), invisible);
          paintedTables_.append(painted);
          continue;
        }

        QTextTableFormat tableFormat;
        tableFormat.setBorder(0);
        tableFormat.setMargin(0);
        tableFormat.setAlignment(Qt::AlignLeft);
        tableFormat.setBorderBrush(Qt::NoBrush);
        tableFormat.setCellSpacing(0);
        tableFormat.setCellPadding(0);
        tableFormat.setTopMargin(0);
        tableFormat.setBottomMargin(0);
        tableFormat.setWidth(QTextLength(QTextLength::FixedLength, total));
        QList<QTextLength> constraints;
        for (qreal width : natural) constraints.append(QTextLength(QTextLength::FixedLength, width));
        tableFormat.setColumnWidthConstraints(constraints);
        tableFormat.setProperty(RoleProperty, RoleTable);
        tableFormat.setProperty(NodeProperty, currentNode);
        tableFormat.setProperty(SegmentProperty, segment);
        tableFormat.setProperty(HeaderIsBodyProperty, block.value("headerIsBody").toBool());

        QTextBlockFormat format = bodyBlock();
        // The legacy overflow-x:auto tableWrapper prevents the table's 16px
        // margin from collapsing through it with a preceding heading's 12px.
        // Ordinary paragraph siblings still use the collapsed-margin path.
        const bool afterHeading = cursor.blockFormat().intProperty(RoleProperty) == RoleHeading;
        format.setTopMargin(firstContent ? 0 : 16 + (afterHeading ? 12 : 0));
        // Qt drops the following block's top margin after a table frame, so the
        // table's own bottom margin carries the stylesheet's 16px plus the next
        // block's 16px rhythm.
        format.setBottomMargin(32);
        openBlock(format, segment);
        QTextTable* table = cursor.insertTable(rows.size() + 1, columns, tableFormat);
        tableRefs_.append({table, natural});

        auto fill = [&](int row, int column, const QJsonArray& runs, bool headerCell) {
          QTextTableCell cell = table->cellAt(row, column);
          QTextTableCellFormat cellFormat;
          const auto semantic = cellHeaders.value({row, column});
          // Metadata only: do not reinterpret the retained HTML or change layout.
          const bool semanticHeader = semantic.isEmpty() ? (headerRows.isEmpty() && headerCell) : semantic.value("header").toBool();
          cellFormat.setProperty(CellHeaderProperty, semanticHeader);
          cellFormat.setProperty(CellScopeProperty, semantic.isEmpty() ? (semanticHeader ? QStringLiteral("col") : QStringLiteral("auto"))
                                                                     : semantic.value("scope").toString(QStringLiteral("unknown")));
          cellFormat.setBorder(0);
          // Qt places the first row's text flush with the table frame and only
          // honours cell padding between rows. Carry CSS's 6px padding plus
          // the grid-border allowance in the cell spacer and bottom padding.
          cellFormat.setTopPadding(0);
          cellFormat.setBottomPadding(7);
          cellFormat.setLeftPadding(10);
          cellFormat.setRightPadding(10);
          cell.setFormat(cellFormat);
          QTextCursor cellCursor = cell.firstCursorPosition();
          // Qt lays the first block of a cell out flush with the cell's top edge
          // and adds cell padding below it, so a 7px spacer block provides the
          // stylesheet's padding and grid-border allowance above.
          QTextBlockFormat spacer;
          spacer.setTopMargin(0);
          spacer.setBottomMargin(0);
          spacer.setLineHeight(7, QTextBlockFormat::FixedHeight);
          cellCursor.setBlockFormat(spacer);
          QTextCharFormat spacerMark;
          spacerMark.setFont(theme::uiFont(1));
          spacerMark.setForeground(Qt::transparent);
          cellCursor.insertText(QString(QChar(0x200B)), spacerMark);
          QTextBlockFormat cellBlock;
          cellBlock.setProperty(RoleProperty, RoleTable);
          cellBlock.setProperty(SegmentProperty, segment);
          cellBlock.setProperty(NodeProperty, currentNode);
          cellBlock.setProperty(TableRowProperty, row);
          cellBlock.setProperty(TableColumnProperty, column);
          // Presentation preference only: the retained plan keeps the authored
          // Markdown alignment markers for serialization and saving.
          cellBlock.setAlignment(Qt::AlignLeft);
          cellBlock.setLineHeight(28, QTextBlockFormat::FixedHeight);
          cellBlock.setTopMargin(0);
          cellBlock.setBottomMargin(0);
          cellCursor.insertBlock(cellBlock);
          QTextCharFormat base;
          base.setFont(theme::uiFont(kBody, headerCell ? QFont::Bold : QFont::Normal));
          base.setForeground(theme::text());
          cellCursor.setBlockCharFormat(base);
          cellCursor.setCharFormat(base);
          const int authoredStart = cellCursor.position();
          insertRuns(cellCursor, runs, base);
          if (!headerRows.isEmpty()) {
            // Raw previews are read-only and rebuilt from source on changes.
            // mergeCells can append separator/spacer text from covered empty
            // cells. Retain the actual content extent, not a duplicate string.
            auto metadata = cell.format();
            metadata.setProperty(AuthoredCellLengthProperty, cellCursor.position() - authoredStart);
            cell.setFormat(metadata);
          }
        };

        for (int column = 0; column < columns; ++column) {
          fill(0, column, header.at(column).toArray(), !block.value("headerIsBody").toBool());
        }
        for (int row = 0; row < rows.size(); ++row) {
          const QJsonArray cells = rows.at(row).toArray();
          for (int column = 0; column < columns; ++column) {
            fill(row + 1, column, column < cells.size() ? cells.at(column).toArray() : QJsonArray(), false);
          }
        }

        for (const auto& span : spans)
          if (span.rows > 1 || span.columns > 1) table->mergeCells(span.row, span.column, span.rows, span.columns);
        cursor = table->lastCursorPosition();
        cursor.movePosition(QTextCursor::NextBlock);

        // A block that follows a table frame ignores its own top margin in Qt's
        // layout, so the stylesheet's gap after the table is carried by an
        // explicit 16px spacer paragraph instead. The following block still
        // contributes its own margin; carrying it here too adds 16px twice.
        QTextBlockFormat spacerFormat;
        spacerFormat.setTopMargin(0);
        spacerFormat.setBottomMargin(0);
        spacerFormat.setLineHeight(16, QTextBlockFormat::FixedHeight);
        cursor.setBlockFormat(spacerFormat);
        QTextCharFormat invisible;
        invisible.setFont(theme::uiFont(1));
        invisible.setForeground(Qt::transparent);
        cursor.insertText(QString(QChar(0x200B)), invisible);
        afterTable = false;
        continue;
      }

      if (type == QStringLiteral("hr")) {
        QTextBlockFormat format = bodyBlock();
        format.setTopMargin(firstContent ? 0 : 24);
        format.setLineHeight(2, QTextBlockFormat::FixedHeight);
        format.setProperty(RoleProperty, RoleRule);
        openBlock(format, segment);
        QTextCharFormat spacer;
        spacer.setFont(theme::uiFont(1));
        spacer.setForeground(Qt::transparent);
        cursor.insertText(QString(QChar(0x200B)), spacer);
        continue;
      }
    }
  };

  insertBlocks(blocks, 0, -1);
  if (firstContent && hiddenInsertionSegment >= 0) {
    // Metadata-only documents still need a safe insertion point. Its serializer
    // appends body text after the hidden source instead of replacing that source.
    currentNode = hiddenInsertionNode; currentListDepth = -1;
    quoteDepth = 0; quoteListInsets.clear();
    openBlock(bodyBlock(), hiddenInsertionSegment);
    cursor.setCharFormat(bodyFormat());
    editableSegments_.insert(hiddenInsertionSegment);
  }
  cursor.endEditBlock();
}

bool DocumentView::refreshParagraphIndents(const QTextBlock& only) {
  if (previewMode_ || building_) return false;
  QVector<QPair<QTextBlock, qreal>> changes;
  for (QTextBlock block = only.isValid() ? only : document_->begin(); block.isValid(); block = block.next()) {
    const auto format = block.blockFormat();
    if (format.intProperty(RoleProperty) == RoleBody && !format.hasProperty(ListDepthProperty) &&
        format.intProperty(QuoteDepthProperty) == 0 && !QTextCursor(block).currentTable()) {
      const qreal desired = chineseFirstLineIndent(block.text());
      if (qAbs(format.textIndent() - desired) > 0.01) changes.append({block, desired});
    }
    if (only.isValid()) break;
  }
  if (changes.isEmpty()) return false;
  // Join the edit that changed the visible prefix. This is display formatting,
  // not a second undo step; Undo restores both the text and the derived indent.
  QTextCursor transaction(document_);
  transaction.joinPreviousEditBlock();
  for (const auto& change : changes) {
    QTextCursor cursor(change.first);
    auto format = change.first.blockFormat(); format.setTextIndent(change.second);
    cursor.setBlockFormat(format);
  }
  transaction.endEditBlock();
  return true;
}

void DocumentView::relayout() {
  if (document_ == nullptr) return;

  const qreal width = contentWidth();
  for (auto& surface : rawSurfaces_) {
    surface.preview->resize(qRound(width), surface.preview->height());
    // A hidden QAbstractScrollArea delays its viewport resize until showEvent.
    // Measuring against that stale (often 160px) viewport caches a many-line
    // object height in the parent, even after the child paints at full width.
    // Raw previews occupy the entire reading column, with no inner gutter.
    surface.preview->document()->setTextWidth(width);
  }

  // Frames can be destroyed/recreated by delete and undo. Never retain a stale
  // QTextTable pointer across an editing transaction.
  tableRefs_.clear();
  std::function<void(QTextFrame*)> collectTables = [&](QTextFrame* frame) {
    for (QTextFrame* child : frame->childFrames()) {
      if (auto* table = qobject_cast<QTextTable*>(child)) tableRefs_.append(TableRef{table, {}});
      collectTables(child);
    }
  };
  collectTables(document_->rootFrame());

  // Object intrinsic sizes follow viewport/image metadata without editing undo history.
  document_->markContentsDirty(0,document_->characterCount());
  document_->setTextWidth(width);

#ifdef VELLORA_ENABLE_TEST_HOOKS
  if (qEnvironmentVariableIsSet("VELLORA_LAYOUT_DUMP")) {
    QFile file(QDir::temp().filePath(QStringLiteral("vellora-layout.txt")));
    if (file.open(QIODevice::WriteOnly | QIODevice::Text)) {
      QTextStream out(&file);
      const QStringList families = QFontDatabase::families();
      QStringList variable;
      for (const QString& family : families) {
        if (family.contains(QStringLiteral("Variable"))) variable << family;
      }
      out << "variable families=" << variable.join(QStringLiteral(" | ")) << "\n";
      const QFontInfo info(theme::uiFont(16));
      const QString sample = QStringLiteral(
          "Vellora 用于阅读、直接编辑与源码编辑。这份文档用于对照中文、English、数字 0123456789，以及 强");
      out << "sample advance=" << QFontMetricsF(theme::uiFont(16)).horizontalAdvance(sample) << "\n";
      out << "font=" << info.family() << " px=" << info.pixelSize() << " weight=" << info.weight()
          << "\n";
      out << "viewport=" << viewport()->width() << "x" << viewport()->height()
          << " contentWidth=" << width << " left=" << contentLeft()
          << " docSize=" << document_->size().width() << "x" << document_->size().height() << "\n";
      for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
        const int role = block.blockFormat().intProperty(RoleProperty);
        if (role != RoleCode && role != RoleQuote && role != RoleHeading) continue;
        const QRectF r = document_->documentLayout()->blockBoundingRect(block);
        out << "block role=" << role << " rect=" << r.left() << "," << r.top() << " " << r.width()
            << "x" << r.height() << " text=" << block.text().left(12) << "\n";
      }
      for (const TableRef& ref : tableRefs_) {
        if (!ref.table) continue;
        const QList<QTextLength> c = ref.table->format().columnWidthConstraints();
        out << "table frameTop=" << document_->documentLayout()->frameBoundingRect(ref.table).top()
            << " frameLeft=" << document_->documentLayout()->frameBoundingRect(ref.table).left();
        out << " table cols=" << c.size() << " widths=";
        for (const QTextLength& length : c) out << length.rawValue() << ",";
        out << " frame=" << document_->documentLayout()->frameBoundingRect(ref.table).width() << "\n";
        for (int r = 0; r < qMin(3, ref.table->rows()); ++r) {
          for (int c = 0; c < qMin(2, ref.table->columns()); ++c) {
            QTextTableCell cell = ref.table->cellAt(r, c);
            QTextTableCellFormat cf = cell.format().toTableCellFormat();
            const QTextCursor cc = cell.firstCursorPosition();
            const QRectF cr = document_->documentLayout()->blockBoundingRect(cc.block());
            out << "  cell(" << r << "," << c << ") pad=" << cf.topPadding() << "/" << cf.bottomPadding()
                << " blockTop=" << cr.top() << " h=" << cr.height() << "\n";
          }
        }
      }
    }
  }

#endif
  cachedDocumentHeight_=document_->size().height();
  updateScrollRange();
  rebuildDecorations();
  layoutRawSurfaces();
  viewport()->update();
}

void DocumentView::updateScrollRange() {
  const qreal contentHeight = empty_ ? 0 : cachedDocumentHeight_>=0?cachedDocumentHeight_:document_->size().height();
  const int total = qCeil(contentHeight) + topPadding() + bottomPadding();
  const int page = viewport()->height();
  verticalScrollBar()->setRange(0, qMax(0, total - page));
  verticalScrollBar()->setPageStep(page);
  verticalScrollBar()->setSingleStep(48);
}

QRectF DocumentView::codeTextBounds(const QTextBlock& block, const QRectF& blockRect) const {
  // Qt's blockBoundingRect can exclude the extra leading of a minimum/fixed
  // line box. Painting, hit testing and scroll controls must cover actual lines.
  qreal top = blockRect.top(), bottom = blockRect.bottom();
  if (const auto* layout = block.layout()) {
    for (int i = 0; i < layout->lineCount(); ++i) {
      const auto line = layout->lineAt(i);
      top = qMin(top, blockRect.top() + line.y());
      bottom = qMax(bottom, blockRect.top() + line.y() + line.height());
    }
    if (!block.blockFormat().boolProperty(RawProperty))
      bottom = qMax(bottom, blockRect.top() + layout->lineCount() * 25.6);
  }
  return QRectF(blockRect.left(), top, blockRect.width(), bottom - top);
}

void DocumentView::rebuildDecorations() {
  horizontalRegions_.clear();
  blockRectCache_.clear();
  codeBoxes_.clear();
  quoteBars_.clear();
  ruleLines_.clear();
  imageBoxes_.clear();
  tableBoxes_.clear();
  inlineBoxes_.clear();
  if (empty_ || document_ == nullptr) return;

  QAbstractTextDocumentLayout* layout = document_->documentLayout();
  const qreal width = contentWidth();
  QHash<int, int> activeQuoteBars;

  for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
    if (!block.isVisible()) continue;
    const QTextBlockFormat format = block.blockFormat();
    const int role = format.intProperty(RoleProperty);
    const QRectF blockRect = layout->blockBoundingRect(block);
    blockRectCache_.insert(block.blockNumber(),blockRect);
    const int quoteLevels = qMax(role == RoleQuote ? 1 : 0, format.intProperty(QuoteDepthProperty));
    for (int level : activeQuoteBars.keys()) if (level > quoteLevels) activeQuoteBars.remove(level);

    if (role == RoleCode) {
      // blockBoundingRect starts at the document's left edge and already subtracts
      // the block's horizontal margins, so the surface is the full reading column
      // expanded by the 16px code padding.
      const QRectF textBounds = codeTextBounds(block, blockRect);
      codeBoxes_.append({QRectF(0, textBounds.top() - 16, width, textBounds.height() + 32)});
      HorizontalRegion region;
      region.node = format.intProperty(NodeProperty);
      region.blockPosition = block.position();
      const qreal textWidth = format.boolProperty(RawProperty) ? width : qMax<qreal>(32, width - 52);
      region.rect = QRectF(0, textBounds.top(), textWidth, textBounds.height());
      qreal natural = 0;
      for (int i = 0; i < block.layout()->lineCount(); ++i)
        natural = qMax(natural, block.layout()->lineAt(i).naturalTextWidth() + 32);
      region.maximum = qMax<qreal>(0, natural - textWidth);
      region.scroll = qBound<qreal>(0, horizontalOffsets_.value(region.node), region.maximum);
      region.track = QRectF(12, textBounds.bottom() + 11, width - 24, 4);
      const qreal thumbWidth = qMin(region.track.width(), qMax<qreal>(24, region.track.width() * textWidth / qMax(textWidth, natural)));
      region.thumb = QRectF(region.track.left() + (region.maximum > 0 ? region.scroll / region.maximum * (region.track.width() - thumbWidth) : 0), region.track.top(), thumbWidth, 4);
      if (!format.boolProperty(RawProperty)) region.copy = QRectF(width - 40, textBounds.top(), 28, 28);
      horizontalRegions_.append(region);
    } else if (role == RoleQuote || format.intProperty(QuoteDepthProperty) > 0) {
      // Each nesting level owns its border. Outer borders continue through
      // deeper children instead of collapsing all quote depths onto x=0.
      const qreal height = qMax(blockRect.height(), block.layout()->lineCount() * 28.0) + 6.4;
      const QVariantList insets = format.property(QuoteListInsetsProperty).toList();
      for (int level = 1; level <= quoteLevels; ++level) {
        const qreal listInset = level <= insets.size() ? insets.at(level - 1).toReal() : 0;
        const QRectF bar(listInset + (level - 1) * 18, blockRect.top(), 2, height);
        if (activeQuoteBars.contains(level)) {
          QuoteBar& previous = quoteBars_[activeQuoteBars.value(level)];
          const qreal gap = bar.top() - previous.rect.bottom();
          if (gap >= -1 && gap <= 24 && qAbs(previous.rect.left() - bar.left()) < 0.1) {
            previous.rect.setBottom(qMax(previous.rect.bottom(), bar.bottom()));
            continue;
          }
        }
        activeQuoteBars[level] = quoteBars_.size();
        quoteBars_.append({bar});
      }
    } else if (role == RoleRule) {
      const qreal y = blockRect.center().y();
      ruleLines_.append({QPointF(0, y), QPointF(width, y)});
    } else if (role == RoleImage) {
      const QSize current=imageSizes_.value(normalizedImagePath(format.stringProperty(ImagePathProperty)),QSize(format.intProperty(ImageWidthProperty),format.intProperty(ImageHeightProperty)));
      const int naturalWidth = current.width();
      const int naturalHeight = current.height();
      if (naturalWidth > 0 && naturalHeight > 0) {
        const qreal displayWidth = qMin<qreal>(naturalWidth, width);
        const qreal displayHeight = naturalHeight * displayWidth / naturalWidth;
        imageBoxes_.append({QRectF(blockRect.left(), blockRect.top(), displayWidth, displayHeight),
                            format.property(ImagePathProperty).toString(), true});
      }
    }
  }

  for (const TableRef& ref : tableRefs_) {
    if (ref.table == nullptr) continue;
    QRectF rect = layout->frameBoundingRect(ref.table);
    rect.moveLeft(rect.left()-10);
    if (rect.isEmpty()) continue;

    const int rows = ref.table->rows();
    const int columns = ref.table->columns();
    if (rows == 0 || columns == 0) continue;

    QVector<qreal> rowY;
    rowY.reserve(rows + 1);
    qreal bottom = rect.top();
    for (int row = 0; row < rows; ++row) {
      qreal top = std::numeric_limits<qreal>::max();
      qreal rowBottom = 0;
      for (int column = 0; column < columns; ++column) {
        const QTextCursor cell = ref.table->cellAt(row, column).lastCursorPosition();
        const QRectF cellRect = layout->blockBoundingRect(cell.block());
        top = qMin(top, cellRect.top() - 7);
        rowBottom = qMax(rowBottom, cellRect.bottom() + 7);
      }
      rowY.append(top);
      bottom = qMax(bottom, rowBottom);
    }
    rowY.append(bottom);

    QVector<qreal> colX;
    colX.reserve(columns + 1);
    qreal x = rect.left();
    const QTextTableFormat tableFormat = ref.table->format();
    const QList<QTextLength> constraints = tableFormat.columnWidthConstraints();
    for (int column = 0; column < columns; ++column) {
      colX.append(x);
      const qreal columnWidth = column < constraints.size()
                                    ? constraints.at(column).rawValue()
                                    : rect.width() / columns;
      x += columnWidth;
    }
    colX.append(x);

    HorizontalRegion region;
    region.node = tableFormat.intProperty(NodeProperty);
    region.rect = QRectF(0, rect.top(), width, rect.height());
    region.maximum = qMax<qreal>(0, rect.width() - width);
    region.scroll = qBound<qreal>(0, horizontalOffsets_.value(region.node), region.maximum);
    region.track = QRectF(12, rect.bottom() - 5, qMax<qreal>(24, width - 24), 4);
    const qreal thumbWidth = region.track.width() * width / qMax(width, rect.width());
    region.thumb = QRectF(region.track.left() + (region.maximum > 0 ? region.scroll / region.maximum * (region.track.width() - thumbWidth) : 0), region.track.top(), thumbWidth, 4);
    horizontalRegions_.append(region);
    TableBox box; box.rect = rect; box.rows = rowY; box.columns = colX; box.scroll = region.scroll;
    box.header = !tableFormat.boolProperty(HeaderIsBodyProperty);
    for (int row = 0; row < rows; ++row) for (int column = 0; column < columns; ++column) {
      const auto cell = ref.table->cellAt(row, column);
      if (cell.row() != row || cell.column() != column) continue;
      const int right = qMin(columns, column + cell.columnSpan());
      const int bottomRow = qMin(rows, row + cell.rowSpan());
      if (right < columns) box.grid.append(QLineF(colX.at(right), rowY.at(row), colX.at(right), rowY.at(bottomRow)));
      if (bottomRow < rows) box.grid.append(QLineF(colX.at(column), rowY.at(bottomRow), colX.at(right), rowY.at(bottomRow)));
    }
    tableBoxes_.append(box);
  }

  for (PaintedTable& table : paintedTables_) {
    const QTextBlock block = document_->findBlock(table.blockPosition);
    if (!block.isValid()) continue;
    const QRectF blockRect = layout->blockBoundingRect(block);
    const qreal bodyHeight = table.cells.size() * 40.0;
    qreal total = 0;
    for (qreal column : table.columns) total += column;
    table.columnWidth = contentWidth();
    table.rect = QRectF(0, blockRect.top(), table.columnWidth, bodyHeight + 12);
    table.maxScroll = qMax<qreal>(0, total - table.columnWidth);
    table.scroll = qBound<qreal>(0, table.scroll, table.maxScroll);
    const qreal thumbWidth =
        total > 0 ? (table.columnWidth - 24) * (table.columnWidth / total) : table.columnWidth - 24;
    table.scrollTrack = QRectF(12, table.rect.top() + bodyHeight - 5, qMax<qreal>(24, table.columnWidth - 24), 4);
    const qreal thumbX = table.scrollTrack.left() + (table.maxScroll > 0
                             ? table.scroll / table.maxScroll * (table.scrollTrack.width() - thumbWidth)
                             : 0);
    table.scrollThumb = QRectF(thumbX, table.scrollTrack.top(), thumbWidth, 4);
  }

#ifdef VELLORA_ENABLE_TEST_HOOKS
  if (qEnvironmentVariableIsSet("VELLORA_TABLE_SCROLL") && !paintedTables_.isEmpty()) {
    PaintedTable& table = paintedTables_.first();
    table.scroll = qBound<qreal>(0, qEnvironmentVariableIntValue("VELLORA_TABLE_SCROLL"),
                                 table.maxScroll);
    const qreal range = table.scrollTrack.width() - table.scrollThumb.width();
    if (range > 0 && table.maxScroll > 0) {
      table.scrollThumb.moveLeft(table.scrollTrack.left() + table.scroll / table.maxScroll * range);
    }
  }

#endif
  // Inline code: the char format carries no background, so the pill is painted
  // from the layout's format ranges at the exact glyph positions.
  for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
    QTextLayout* textLayout = block.layout();
    if (textLayout == nullptr) continue;
    QList<QTextLayout::FormatRange> formats;
    for (auto it = block.begin(); !it.atEnd(); ++it) {
      const auto fragment = it.fragment();
      if (fragment.isValid()) formats.append({fragment.position()-block.position(), fragment.length(), fragment.charFormat()});
    }
    if (formats.isEmpty()) continue;
    const QRectF blockRect = layout->blockBoundingRect(block);
    for (const QTextLayout::FormatRange& range : formats) {
      if (!range.format.boolProperty(InlineCodeProperty)) continue;
      for (int index = 0; index < textLayout->lineCount(); ++index) {
        QTextLine line = textLayout->lineAt(index);
        const int start = qMax(range.start, line.textStart());
        const int end = qMin(range.start + range.length, line.textStart() + line.textLength());
        if (start >= end) continue;
        qreal offset = blockRect.left();
        for (const auto& region : horizontalRegions_) if (region.node == block.blockFormat().intProperty(NodeProperty)) { offset -= region.scroll; break; }
        const qreal x1 = offset + line.cursorToX(start);
        const qreal x2 = offset + line.cursorToX(end);
        if (x2 <= x1) continue;
        QFontMetricsF metrics(range.format.font());
        const qreal height = metrics.height() + kInlineCodePadY * 2;
        const qreal y = blockRect.top() + line.y() + (line.height() - height) / 2.0;
        inlineBoxes_.append({QRectF(x1 - kInlineCodePadX, y, x2 - x1 + kInlineCodePadX * 2, height)});
      }
    }
  }
}

void DocumentView::paintDecorations(QPainter& painter) {
  painter.save();
  painter.setClipRect(QRectF(0, scrollValue()-topPadding(), contentWidth(), viewport()->height()), Qt::IntersectClip);
  painter.setRenderHint(QPainter::Antialiasing, true);

  // Code blocks: 12px rounded surface with 16px padding.
  for (const CodeBox& box : codeBoxes_) {
    if(!box.rect.intersects(painter.clipBoundingRect()))continue;
    painter.setPen(Qt::NoPen);
    painter.setBrush(theme::codeBg());
    painter.drawRoundedRect(box.rect, kRadiusCode, kRadiusCode);
  }

  // Quote rule: 2px, 20% ink, spanning the whole quote.
  painter.setPen(Qt::NoPen);
  painter.setBrush(theme::borderStrong());
  for (const QuoteBar& bar : quoteBars_) {
    if(!bar.rect.intersects(painter.clipBoundingRect()))continue;
    painter.drawRect(bar.rect);
  }

  // Horizontal rules: 1px hairline across the reading column.
  painter.setRenderHint(QPainter::Antialiasing, false);
  painter.setPen(QPen(theme::border(), 1));
  for (const RuleLine& line : ruleLines_) {
    painter.drawLine(line.from, line.to);
  }
  painter.setRenderHint(QPainter::Antialiasing, true);

  // Tables: header band, hairline grid, rounded outer frame.
  for (const TableBox& table : tableBoxes_) {
    if(!table.rect.intersects(painter.clipBoundingRect()))continue;
    const QRectF rect = table.rect;
    const int rows = table.rows.size() - 1;
    const int columns = table.columns.size() - 1;
    if (rows <= 0 || columns <= 0) continue;

    painter.save();
    painter.setClipRect(QRectF(0, rect.top(), contentWidth(), rect.height()), Qt::IntersectClip);
    const QRectF container(rect.left(),rect.top(),qMin<qreal>(contentWidth(),rect.width()),rect.height());
    QPainterPath rounded;
    rounded.addRoundedRect(container.adjusted(0.5,0.5,-0.5,-0.5),kRadiusCode,kRadiusCode);

    painter.save();
    painter.setClipPath(rounded, Qt::IntersectClip);
    painter.translate(-table.scroll,0);
    painter.setPen(Qt::NoPen);
    painter.setBrush(theme::bg());
    if (table.header) painter.fillRect(QRectF(rect.left(), table.rows.at(0), rect.width(),
                            table.rows.at(1) - table.rows.at(0)),
                     theme::bg());
    painter.restore();

    painter.save();
    painter.setClipPath(rounded, Qt::IntersectClip);
    painter.translate(-table.scroll,0);
    painter.setRenderHint(QPainter::Antialiasing, false);
    painter.setPen(QPen(theme::border(), 1));
    for (const auto& line : table.grid) painter.drawLine(line);
    painter.restore();

    painter.setRenderHint(QPainter::Antialiasing, true);
    painter.setPen(QPen(theme::border(), 1));
    painter.setBrush(Qt::NoBrush);
    painter.drawRoundedRect(container.adjusted(0.5, 0.5, -0.5, -0.5), kRadiusCode, kRadiusCode);
    painter.setRenderHint(QPainter::Antialiasing, false);
    painter.restore();
  }

  // Inline code pills behind the glyphs.
  painter.setRenderHint(QPainter::Antialiasing, true);
  painter.setPen(Qt::NoPen);
  painter.setBrush(theme::codeBg());
  for (const InlineBox& box : inlineBoxes_) {
    const QRectF visible=painter.clipBoundingRect();if(box.rect.bottom()<visible.top()||box.rect.top()>visible.bottom())continue;
    painter.save();
    for(const auto& region:horizontalRegions_)if(box.rect.center().y()>=region.rect.top()&&box.rect.center().y()<=region.rect.bottom()){
      painter.setClipRect(region.rect,Qt::IntersectClip);
      if(region.copy.isEmpty()){qreal width=region.rect.width();for(const auto& table:tableBoxes_)if(qAbs(table.rect.top()-region.rect.top())<.5){width=qMin(width,table.rect.width());break;}QPainterPath rounded;rounded.addRoundedRect(QRectF(region.rect.left(),region.rect.top(),width,region.rect.height()).adjusted(1,1,-1,-1),kRadiusCode,kRadiusCode);painter.setClipPath(rounded,Qt::IntersectClip);}
      painter.translate(-region.scroll,0);break;
    }
    painter.drawRoundedRect(box.rect, 4, 4);painter.restore();
  }

  paintTables(painter);

  // Images with the stylesheet's 6px rounding.
  for (const ImageBox& image : imageBoxes_) {
    const qreal visibleTop = scrollValue() - topPadding();
    if (image.rect.bottom() < visibleTop - 200 || image.rect.top() > visibleTop + viewport()->height() + 200) continue;
    QImage pixmap = decodedImage(image.path);
    if (pixmap.isNull()) continue;
    painter.save();
    QPainterPath clip;
    clip.addRoundedRect(image.rect, kRadiusContent, kRadiusContent);
    painter.setClipPath(clip);
    painter.setRenderHint(QPainter::SmoothPixmapTransform, true);
    painter.drawImage(image.rect, pixmap);
    painter.restore();
  }

  painter.restore();
}

void DocumentView::paintTables(QPainter& painter) {
  for (const PaintedTable& table : paintedTables_) {
    if (table.rect.isEmpty() || table.cells.isEmpty()) continue;
    const qreal bodyHeight = table.cells.size() * 40.0;
    const QRectF body(0, table.rect.top(), table.columnWidth, bodyHeight);

    painter.save();
    painter.setClipRect(QRectF(0, table.rect.top(), table.columnWidth, table.rect.height()));

    painter.setPen(Qt::NoPen);
    painter.fillRect(QRectF(0, table.rect.top(), table.columnWidth, 40), theme::bg());

    for (int row = 0; row < table.cells.size(); ++row) {
      qreal x = -table.scroll;
      for (int column = 0; column < table.cells.at(row).size(); ++column) {
        const qreal width = table.columns.value(column, 96.0);
        const QRectF cellRect(x, table.rect.top() + row * 40.0, width, 40.0);
        painter.save();
        painter.setClipRect(cellRect);
        qreal tx = cellRect.left() + 10;
        for (const TableRun& run : table.cells.at(row).at(column)) {
          QFont font = run.code ? theme::monoFont(14)
                                : theme::uiFont(16, run.bold ? QFont::Bold : QFont::Normal);
          font.setItalic(run.italic);
          font.setStrikeOut(run.strike);
          const QFontMetricsF metrics(font);
          painter.setFont(font);
          painter.setPen(run.href.isEmpty() ? theme::text() : theme::accent());
          const qreal baseline = cellRect.top() + 9 + (22 - metrics.height()) / 2 + metrics.ascent();
          painter.drawText(QPointF(tx, baseline), run.text);
          const qreal advance = metrics.horizontalAdvance(run.text);
          if (!run.href.isEmpty()) {
            painter.setPen(QPen(QColor("#86b6ef"), 1));
            painter.drawLine(QPointF(tx, baseline + 2), QPointF(tx + advance, baseline + 2));
          }
          tx += advance;
        }
        painter.restore();
        x += width;
      }
    }

    painter.save();
    painter.setClipRect(body);
    painter.setRenderHint(QPainter::Antialiasing, false);
    painter.setPen(QPen(theme::border(), 1));
    for (int row = 1; row < table.cells.size(); ++row) {
      const qreal y = body.top() + row * 40.0;
      painter.drawLine(QPointF(0, y), QPointF(table.columnWidth, y));
    }
    qreal x = -table.scroll;
    for (int column = 1; column < table.columns.size(); ++column) {
      x += table.columns.at(column - 1);
      if (x > 0.5 && x < table.columnWidth - 0.5) {
        painter.drawLine(QPointF(x, body.top()), QPointF(x, body.bottom()));
      }
    }
    painter.restore();

    painter.setRenderHint(QPainter::Antialiasing, true);
    painter.setPen(QPen(theme::border(), 1));
    painter.setBrush(Qt::NoBrush);
    painter.drawRoundedRect(QRectF(0.5, body.top() + 0.5, table.columnWidth - 1, bodyHeight - 1),
                            12, 12);

    if (table.maxScroll > 0) {
      painter.setPen(Qt::NoPen);
      painter.setBrush(QColor(11, 11, 11, 26));
      painter.drawRoundedRect(table.scrollThumb, 2, 2);
    }
    painter.restore();
  }
}

void DocumentView::paintEmptyState(QPainter& painter) {
  painter.save();
  painter.setRenderHint(QPainter::Antialiasing, true);

  const int width = viewport()->width();
  const int height = viewport()->height();
  const QString title = errorMessage_.isEmpty()?QStringLiteral("未打开文件"):QStringLiteral("打开失败");
  const QString hint = errorMessage_.isEmpty()?QStringLiteral("请选择 .md 或 .markdown 文件。"):errorMessage_;

  QFont titleFont = theme::uiFont(15,QFont::DemiBold);
  QFont hintFont = theme::uiFont(14);
  QFontMetricsF titleMetrics(titleFont);
  QFontMetricsF hintMetrics(hintFont);
  const int iconSize = errorMessage_.isEmpty()?56:0;
  const int gap = 12;
  const int buttonHeight = 32;
  const qreal hintHeight=hintMetrics.boundingRect(QRectF(0,0,qMax(1,width-64),100000),Qt::AlignHCenter|Qt::TextWrapAnywhere,hint).height();
  const qreal blockHeight = (iconSize?iconSize+gap:0)+titleMetrics.height()+gap+hintHeight+gap+buttonHeight;
  qreal y = (height - blockHeight) / 2.0;

  const QIcon icon = QApplication::windowIcon();
  const QRect iconRect((width - iconSize) / 2, qRound(y), iconSize, iconSize);
  if (iconSize && !icon.isNull()) {
    painter.setClipRect(iconRect);
    icon.paint(&painter, iconRect);
    painter.setClipping(false);
  }
  if(iconSize)y += iconSize + gap;

  painter.setFont(titleFont);
  painter.setPen(theme::text());
  painter.drawText(QRectF(0, y, width, titleMetrics.height()), Qt::AlignHCenter, title);
  y += titleMetrics.height() + gap;

  painter.setFont(hintFont);
  painter.setPen(theme::muted());
  painter.drawText(QRectF(32,y,width-64,hintHeight),Qt::AlignHCenter|Qt::TextWrapAnywhere,hint);
  y += hintHeight+gap;

  const QFont buttonFont = theme::uiFont(13);
  const QFontMetricsF buttonMetrics(buttonFont);
  const QString buttonText=errorMessage_.isEmpty()?QStringLiteral("打开"):QStringLiteral("重新选择");
  const qreal buttonWidth = buttonMetrics.horizontalAdvance(buttonText) + 24;
  const QRectF buttonRect((width - buttonWidth) / 2, y, buttonWidth, buttonHeight);
  painter.setPen(Qt::NoPen);
  painter.setBrush(theme::text());
  painter.drawRoundedRect(buttonRect, theme::radiusControl(), theme::radiusControl());
  painter.setFont(buttonFont);
  painter.setPen(theme::surface());
  painter.drawText(buttonRect, Qt::AlignCenter, buttonText);

  emptyButtonRect_ = buttonRect;
  painter.restore();
}

void DocumentView::paintEvent(QPaintEvent*) {
  paintedImages_.clear();
  QPainter painter(viewport());
  painter.fillRect(viewport()->rect(), theme::surface());

  if (empty_) {
    paintEmptyState(painter);
    return;
  }

  painter.save();
  painter.translate(contentLeft(), topPadding() - verticalScrollBar()->value());
  paintDecorations(painter);

  QAbstractTextDocumentLayout::PaintContext context;
  context.palette = palette();
  context.clip = QRectF(0, scrollValue() - topPadding(), contentWidth(), viewport()->height());
  for (int index = 0; index < matches_.size() && index < 1000; ++index) {
    QAbstractTextDocumentLayout::Selection selection;
    selection.cursor = matches_.at(index);
    selection.format.setBackground(index == activeMatch_ ? theme::searchCurrentBg() : theme::hit());
    selection.format.setForeground(index == activeMatch_ ? theme::searchCurrentText() : theme::text());
    context.selections.append(selection);
  }
  if (activeMatch_ >= 1000 && activeMatch_ < matches_.size()) {
    QAbstractTextDocumentLayout::Selection selection;
    selection.cursor = matches_.at(activeMatch_);
    selection.format.setBackground(theme::searchCurrentBg()); selection.format.setForeground(theme::searchCurrentText());
    context.selections.append(selection);
  }
  const bool searchOwnedSelection = searchSelection_ && activeMatch_ >= 0 && activeMatch_ < matches_.size()
      && cursor_.selectionStart() == matches_.at(activeMatch_).selectionStart()
      && cursor_.selectionEnd() == matches_.at(activeMatch_).selectionEnd();
  if (cursor_.hasSelection() && !searchOwnedSelection) {
    QAbstractTextDocumentLayout::Selection selection;
    selection.cursor = cursor_;
    selection.format.setBackground(palette().color(QPalette::Highlight));
    selection.format.setForeground(palette().color(QPalette::HighlightedText));
    context.selections.append(selection);
  }
  // CSS disc/circle markers are geometric shapes, not the much smaller bullet
  // glyph in Segoe UI Variable. Hide only the generated marker's ink through
  // the transient paint context; retain its document positions and list-editing
  // semantics. Visit visible blocks only, including after incremental edits.
  struct VisibleBullet { QPointF centre; bool nested; QColor colour; };
  QVector<VisibleBullet> bullets;
  auto* textLayout = document_->documentLayout();
  const int firstVisible = textLayout->hitTest(QPointF(0, qMax<qreal>(0, context.clip.top())), Qt::FuzzyHit);
  for (QTextBlock block = document_->findBlock(qMax(0, firstVisible)); block.isValid(); block = block.next()) {
    const QRectF bounds = textLayout->blockBoundingRect(block);
    if (bounds.top() > context.clip.bottom()) break;
    const auto format = block.blockFormat();
    if (!block.isVisible() || !bounds.intersects(context.clip) ||
        !format.hasProperty(ListDepthProperty) || format.boolProperty(ListOrderedProperty) ||
        format.hasProperty(TaskCheckedProperty)) continue;
    auto fragment = block.begin().fragment();
    if (!fragment.isValid() || !fragment.charFormat().boolProperty(ListMarkerProperty)) continue;
    auto* lines = block.layout();
    if (!lines || lines->lineCount() == 0) continue;
    const auto line = lines->lineAt(0);
    QAbstractTextDocumentLayout::Selection hidden;
    hidden.cursor = QTextCursor(document_);
    hidden.cursor.setPosition(fragment.position());
    hidden.cursor.setPosition(fragment.position() + fragment.length(), QTextCursor::KeepAnchor);
    hidden.format.setForeground(Qt::transparent);
    context.selections.append(hidden);
    const int markerEnd = fragment.position() + fragment.length() - block.position();
    const QFontMetricsF metrics(theme::uiFont(kBody));
    QColor colour = format.intProperty(QuoteDepthProperty) > 0 ? theme::muted() : theme::text();
    if (cursor_.hasSelection() && cursor_.selectionStart() <= fragment.position() &&
        cursor_.selectionEnd() > fragment.position()) colour = palette().color(QPalette::HighlightedText);
    bullets.append({QPointF(bounds.left() + line.cursorToX(markerEnd) - 14,
                           bounds.top() + line.y() + line.ascent() - metrics.xHeight() / 2),
                    format.intProperty(ListDepthProperty) > 0, colour});
  }
  // Paint scrolling blocks separately so horizontal movement never moves the
  // reading column, neighbouring prose, or the code-copy button.
  painter.save();
  QRegion ordinary(context.clip.toAlignedRect());
  for (const auto& region : horizontalRegions_) if(region.rect.intersects(context.clip)) {
    // Code reserves the right edge for copy controls. Remove that entire strip
    // from ordinary painting too, otherwise unscrolled long text leaks beneath it.
    const QRectF excluded = region.blockPosition >= 0
        ? QRectF(0, region.rect.top(), contentWidth(), region.rect.height()) : region.rect;
    ordinary -= QRegion(excluded.toAlignedRect());
  }
  painter.setClipRegion(ordinary, Qt::IntersectClip);
  document_->documentLayout()->draw(&painter, context);
  painter.restore();
  for (const auto& region : horizontalRegions_) {
    if(!region.rect.intersects(context.clip))continue;
    painter.save();
    painter.setClipRect(region.rect, Qt::IntersectClip);
    if(region.copy.isEmpty()) {
      qreal width=region.rect.width();for(const auto& box:tableBoxes_)if(qAbs(box.rect.top()-region.rect.top())<.5){width=qMin(width,box.rect.width());break;}
      QPainterPath rounded;rounded.addRoundedRect(QRectF(region.rect.left(),region.rect.top(),width,region.rect.height()).adjusted(1,1,-1,-1),kRadiusCode,kRadiusCode);painter.setClipPath(rounded,Qt::IntersectClip);
    }
    painter.translate(-region.scroll, 0);
    auto local = context;
    local.clip = region.rect.intersected(context.clip).translated(region.scroll, 0);
    if (local.clip.isEmpty()) { painter.restore(); continue; }
    document_->documentLayout()->draw(&painter, local);
    painter.restore();
  }
  painter.save();
  painter.setRenderHint(QPainter::Antialiasing, true);
  for (const auto& bullet : bullets) {
    painter.setPen(bullet.nested ? QPen(bullet.colour, 1) : QPen(Qt::NoPen));
    painter.setBrush(bullet.nested ? QBrush(Qt::NoBrush) : QBrush(bullet.colour));
    const qreal radius = bullet.nested ? 2.5 : 3;
    painter.drawEllipse(bullet.centre, radius, radius);
  }
  painter.restore();
  paintCaret(painter);
  const QPointF pointer = toDocument(viewport()->mapFromGlobal(QCursor::pos()));
  for (const auto& region : horizontalRegions_) {
    if(!region.rect.adjusted(0,-16,52,16).intersects(context.clip))continue;
    if (region.maximum > 0) {
      painter.setPen(Qt::NoPen);
      if (region.blockPosition >= 0) {
        painter.setBrush(QColor(11, 11, 11, 16));
        painter.drawRoundedRect(region.track, 2, 2);
      }
      painter.setBrush(QColor(11, 11, 11, 70));
      painter.drawRoundedRect(region.thumb, 2, 2);
    }
    const bool hovered = region.rect.adjusted(0,-16,52,16).contains(pointer);
    const bool focused = hasFocus() && cursor_.blockFormat().intProperty(NodeProperty) == region.node;
    if (!region.copy.isEmpty() && (hovered || focused || copiedNode_ == region.node || copyErrorNode_ == region.node)) {
      painter.save(); painter.setRenderHint(QPainter::Antialiasing,true);
      painter.setPen(Qt::NoPen);
      painter.setBrush(region.copy.contains(pointer) ? theme::border() : QColor(Qt::transparent));
      painter.drawRoundedRect(region.copy, 6, 6);
      painter.setPen(QPen(theme::muted(),1.4)); painter.setBrush(Qt::NoBrush);
      const QPointF origin=region.copy.topLeft();
      if(copiedNode_==region.node) {
        painter.drawLine(origin+QPointF(7,14),origin+QPointF(12,19));
        painter.drawLine(origin+QPointF(12,19),origin+QPointF(22,8));
      } else if(copyErrorNode_==region.node) {
        painter.drawEllipse(origin+QPointF(14,14),8,8);
        painter.drawLine(origin+QPointF(14,9),origin+QPointF(14,15));
        painter.drawPoint(origin+QPointF(14,19));
      } else {
        painter.drawRoundedRect(QRectF(origin+QPointF(6,10),QSizeF(10,12)),1.5,1.5);
        painter.drawRoundedRect(QRectF(origin+QPointF(10,6),QSizeF(10,12)),1.5,1.5);
      }
      if(copiedNode_==region.node || copyErrorNode_==region.node) {
        const QString feedback = copiedNode_==region.node ? QStringLiteral("已复制") : QStringLiteral("复制失败，请重试或手动复制");
        const qreal labelWidth = painter.fontMetrics().horizontalAdvance(feedback) + 12;
        const QRectF label(origin.x()-labelWidth-4,origin.y(),labelWidth,28);
        painter.setPen(Qt::NoPen); painter.setBrush(theme::surface());
        painter.drawRoundedRect(label,4,4);
        painter.setPen(theme::muted()); painter.drawText(label,Qt::AlignCenter,feedback);
      }
      painter.restore();
    }
  }
  painter.restore();
  for (const QString& key : imageCache_.keys()) if (!paintedImages_.contains(key)) imageCache_.remove(key);
  for (const QString& key : animationCache_.keys()) if (!paintedImages_.contains(key)) animationCache_.remove(key);
}

void DocumentView::resizeEvent(QResizeEvent* event) {
  // Reflow invalidates an animation's pixel destination. Let the user's resize
  // take over rather than continuing towards an obsolete heading position.
  stopHeadingScroll();
  QAbstractScrollArea::resizeEvent(event);
  if (empty_) {
    updateScrollRange();
    viewport()->update();
    return;
  }
  // A scrollbar can resize the viewport without changing the capped text column.
  if (qFuzzyCompare(document_->textWidth(), qreal(contentWidth()))) {
    updateScrollRange(); layoutRawSurfaces(); viewport()->update();
  } else relayout();
}

bool DocumentView::writeCodeClipboard(const QString& text) {
#ifdef Q_OS_WIN
  // QClipboard::setText is void. Check the actual Win32 transfer instead of
  // reporting success for a locked clipboard (or an unchanged previous value).
  const SIZE_T bytes = (SIZE_T(text.size()) + 1) * sizeof(wchar_t);
  HGLOBAL data = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (!data) return false;
  void* target = GlobalLock(data);
  if (!target) { GlobalFree(data); return false; }
  std::memcpy(target, text.utf16(), bytes);
  GlobalUnlock(data);
  if (!OpenClipboard(reinterpret_cast<HWND>(window()->winId()))) {
    GlobalFree(data); return false;
  }
  const bool accepted = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, data);
  CloseClipboard();
  // On success the OS owns the allocation, including after this widget closes.
  if (!accepted) GlobalFree(data);
  return accepted;
#else
  auto* clipboard = QApplication::clipboard();
  if (!clipboard) return false;
  clipboard->setText(text);
  return clipboard->ownsClipboard() && clipboard->text() == text;
#endif
}

void DocumentView::resetCodeCopyFeedback() {
  if (copyFeedbackTimer_) copyFeedbackTimer_->stop();
  const bool hadFeedback = copiedNode_ >= 0 || copyErrorNode_ >= 0;
  copiedNode_ = copyErrorNode_ = -1;
  if (hadFeedback) {
    setAccessibleDescription(QString());
    QAccessibleEvent changed(this, QAccessible::DescriptionChanged);
    QAccessible::updateAccessibility(&changed);
  }
  viewport()->update();
}

void DocumentView::copyCodeText(int node, const QString& text) {
  resetCodeCopyFeedback();
  if (!copyFeedbackTimer_) {
    copyFeedbackTimer_ = new QTimer(this);
    copyFeedbackTimer_->setSingleShot(true);
    copyFeedbackTimer_->setTimerType(Qt::PreciseTimer);
    connect(copyFeedbackTimer_, &QTimer::timeout, this, &DocumentView::resetCodeCopyFeedback);
  }
  const bool copied = writeCodeClipboard(text);
  if (copied) copiedNode_ = node;
  else copyErrorNode_ = node;
  setAccessibleDescription(copied ? QStringLiteral("已复制") : QStringLiteral("复制失败，请重试或手动复制"));
  QAccessibleEvent changed(this, QAccessible::DescriptionChanged);
  QAccessible::updateAccessibility(&changed);
  QAccessibleAnnouncementEvent announcement(this, accessibleDescription());
  QAccessible::updateAccessibility(&announcement);
  if (copied) copyFeedbackTimer_->start(2500);
  viewport()->update();
}

void DocumentView::mousePressEvent(QMouseEvent* event) {
  searchSelection_ = false;
  stopHeadingScroll();
  if (empty_) {
    if (event->button() == Qt::LeftButton && emptyButtonRect_.contains(event->pos())) {
      emit openRequested();
      return;
    }
    QAbstractScrollArea::mousePressEvent(event);
    return;
  }
  if (event->button() != Qt::LeftButton) {
    QAbstractScrollArea::mousePressEvent(event);
    return;
  }

  if (isComposing()) {
    if (auto* method = QGuiApplication::inputMethod()) method->commit();
    if (isComposing()) { clearPreeditLayout(); preedit_.clear(); relayout(); emit contentEdited(); }
  }
  const QPointF documentPoint = toDocument(event->pos());
  for (int index = 0; index < horizontalRegions_.size(); ++index) {
    auto& region = horizontalRegions_[index];
    if (!region.copy.isEmpty() && region.copy.contains(documentPoint)) {
      QString text = document_->findBlock(region.blockPosition).text();
      text.replace(QChar::LineSeparator, QLatin1Char('\n'));
      copyCodeText(region.node, text);
      return;
    }
    if (region.maximum > 0 && region.track.adjusted(0, -5, 0, 5).contains(documentPoint)) {
      draggingRegion_ = index; dragStartX_ = documentPoint.x(); dragStartScroll_ = region.scroll;
      if (!region.thumb.contains(documentPoint)) {
        horizontalOffsets_[region.node] = qBound<qreal>(0, (documentPoint.x() - region.track.left()) / region.track.width() * region.maximum, region.maximum);
        rebuildDecorations(); dragStartScroll_ = horizontalRegions_[index].scroll; viewport()->update();
      }
      return;
    }
  }
  for (int index = 0; index < paintedTables_.size(); ++index) {
    PaintedTable& table = paintedTables_[index];
    if (table.maxScroll <= 0) continue;
    if (table.scrollThumb.adjusted(-4, -3, 4, 5).contains(documentPoint)) {
      draggingTable_ = index;
      dragStartX_ = documentPoint.x();
      dragStartScroll_ = table.scroll;
      return;
    }
    if (table.scrollTrack.adjusted(0, -6, 0, 4).contains(documentPoint)) {
      const qreal ratio = qBound<qreal>(0, (documentPoint.x() - table.scrollTrack.left()) / table.scrollTrack.width(), 1);
      table.scroll = ratio * table.maxScroll;
      const qreal range = table.scrollTrack.width() - table.scrollThumb.width();
      if (range > 0) table.scrollThumb.moveLeft(table.scrollTrack.left() + table.scroll / table.maxScroll * range);
      viewport()->update();
      return;
    }
  }

  const int position = document_->documentLayout()->hitTest(hitDocumentPoint(event->pos()), Qt::FuzzyHit);
  if (position < 0) return;
  const QTextBlock taskBlock = document_->findBlock(position);
  if (event->modifiers() == Qt::NoModifier && blockEditable(taskBlock) &&
      taskBlock.blockFormat().hasProperty(TaskCheckedProperty)) {
    const auto fragment = taskBlock.begin().fragment();
    auto* layout = taskBlock.layout();
    if (fragment.isValid() && fragment.charFormat().boolProperty(ListMarkerProperty) && layout && layout->lineCount()) {
      const auto line = layout->lineAt(0);
      const QRectF bounds = document_->documentLayout()->blockBoundingRect(taskBlock);
      const qreal left = bounds.left() + line.cursorToX(0);
      const qreal right = bounds.left() + line.cursorToX(fragment.length());
      const QRectF hit(left, bounds.top() + line.y(), qMax<qreal>(16, right-left), line.height());
      if (hit.contains(documentPoint)) {
        QTextCursor change(taskBlock); change.beginEditBlock();
        auto format = taskBlock.blockFormat();
        const bool checked = !format.boolProperty(TaskCheckedProperty);
        format.setProperty(TaskCheckedProperty, checked); change.setBlockFormat(format);
        change.setPosition(fragment.position());
        change.setPosition(fragment.position()+fragment.length(), QTextCursor::KeepAnchor);
        auto marker = bodyFormat(); marker.setProperty(ListMarkerProperty, true);
        change.insertText(checked ? QStringLiteral("\u2611  ") : QStringLiteral("\u2610  "), marker);
        change.endEditBlock(); cursor_ = change; dragging_ = false;
        setFocus(Qt::MouseFocusReason); resetCaretBlink(); ensureCaretVisible(); viewport()->update();
        return;
      }
    }
  }
  QTextCursor cursor(document_);
  cursor.setPosition(position);
  if (doubleClickTimer_.isValid() && doubleClickTimer_.elapsed() <= QApplication::doubleClickInterval() &&
      cursor.block().position() == doubleClickedBlock_) {
    cursor.select(QTextCursor::BlockUnderCursor); cursor_ = cursor; dragging_ = false;
    doubleClickTimer_.invalidate(); setFocus(Qt::MouseFocusReason); viewport()->update(); return;
  }
  if (event->modifiers() & Qt::ShiftModifier) {
    cursor.setPosition(cursor_.anchor(), QTextCursor::KeepAnchor);
  }
  cursor_ = cursor;
  dragging_ = true;
  setFocus(Qt::MouseFocusReason);
  resetCaretBlink();
  viewport()->update();
}

void DocumentView::mouseMoveEvent(QMouseEvent* event) {
  if (empty_) {
    viewport()->setCursor(emptyButtonRect_.contains(event->pos()) ? Qt::PointingHandCursor
                                                                  : Qt::ArrowCursor);
    return;
  }
  if (draggingRegion_ >= 0 && draggingRegion_ < horizontalRegions_.size() && (event->buttons() & Qt::LeftButton)) {
    const auto& region = horizontalRegions_[draggingRegion_];
    const qreal range = region.track.width() - region.thumb.width();
    if (range > 0) horizontalOffsets_[region.node] = qBound<qreal>(0, dragStartScroll_ + (toDocument(event->pos()).x() - dragStartX_) * region.maximum / range, region.maximum);
    rebuildDecorations(); viewport()->update(); return;
  }
  if (draggingTable_ >= 0 && (event->buttons() & Qt::LeftButton)) {
    PaintedTable& table = paintedTables_[draggingTable_];
    const qreal range = table.scrollTrack.width() - table.scrollThumb.width();
    if (range > 0 && table.maxScroll > 0) {
      const qreal delta = toDocument(event->pos()).x() - dragStartX_;
      table.scroll = qBound<qreal>(0, dragStartScroll_ + delta * table.maxScroll / range, table.maxScroll);
      table.scrollThumb.moveLeft(table.scrollTrack.left() + table.scroll / table.maxScroll * range);
      viewport()->update();
    }
    return;
  }
  if (dragging_ && (event->buttons() & Qt::LeftButton)) {
    const int position = document_->documentLayout()->hitTest(hitDocumentPoint(event->pos()), Qt::FuzzyHit);
    if (position >= 0) {
      QTextCursor cursor(document_);
      cursor.setPosition(cursor_.anchor());
      cursor.setPosition(position, QTextCursor::KeepAnchor);
      cursor_ = cursor;
      viewport()->update();
    }
    return;
  }
  const QPointF documentPoint = toDocument(event->pos());
  viewport()->update();
  for (const auto& region : horizontalRegions_) {
    if ((!region.copy.isEmpty() && region.copy.contains(documentPoint)) ||
        (region.maximum > 0 && region.thumb.adjusted(-3,-4,3,4).contains(documentPoint))) {
      viewport()->setCursor(Qt::PointingHandCursor); return;
    }
  }
  for (const PaintedTable& table : paintedTables_) {
    if (table.maxScroll <= 0) continue;
    if (table.scrollThumb.adjusted(-4, -3, 4, 5).contains(documentPoint)) {
      viewport()->setCursor(Qt::PointingHandCursor);
      return;
    }
  }
  const int position = document_->documentLayout()->hitTest(hitDocumentPoint(event->pos()), Qt::FuzzyHit);
  QString href;
  if (position >= 0) {
    QTextCursor probe(document_);
    probe.setPosition(qMin(position + 1, document_->characterCount() - 1));
    href = probe.charFormat().anchorHref();
  }
  viewport()->setCursor(href.isEmpty() ? Qt::IBeamCursor : Qt::PointingHandCursor);
}

void DocumentView::mouseReleaseEvent(QMouseEvent* event) {
  if (draggingRegion_ >= 0) { draggingRegion_ = -1; return; }
  if (empty_) {
    QAbstractScrollArea::mouseReleaseEvent(event);
    return;
  }
  if (draggingTable_ >= 0) {
    draggingTable_ = -1;
    return;
  }
  const bool wasDragging = dragging_;
  dragging_ = false;
  if (!wasDragging || event->button() != Qt::LeftButton) return;
  if (cursor_.hasSelection()) return;
  const int position = cursor_.position();
  QTextCursor probe(document_);
  probe.setPosition(position);
  QString href = probe.charFormat().anchorHref();
  if (href.isEmpty()) { probe.movePosition(QTextCursor::NextCharacter,QTextCursor::KeepAnchor); href=probe.charFormat().anchorHref(); }
  if (!href.isEmpty() && (event->modifiers() & Qt::ControlModifier)) { emit linkActivated(href); return; }
  if (previewMode_ && readOnly_ && !(event->modifiers() & (Qt::ControlModifier | Qt::ShiftModifier | Qt::AltModifier)))
    emit sourceEditRequested();
}

void DocumentView::mouseDoubleClickEvent(QMouseEvent* event) {
  if (empty_) return;
  const int position = document_->documentLayout()->hitTest(hitDocumentPoint(event->pos()), Qt::FuzzyHit);
  if (position < 0) return;
  QTextCursor cursor(document_);
  cursor.setPosition(position);
  cursor.select(QTextCursor::WordUnderCursor);
  doubleClickTimer_.start(); doubleClickedBlock_ = cursor.block().position();
  cursor_ = cursor;
  viewport()->update();
}

bool DocumentView::focusNextPrevChild(bool next) {
  const int role=cursor_.blockFormat().intProperty(RoleProperty);
  if(!empty_ && !readOnly_ && (role==RoleCode || role==RoleListItem || cursor_.currentTable()))return false;
  return QAbstractScrollArea::focusNextPrevChild(next);
}

void DocumentView::keyPressEvent(QKeyEvent* event) {
  searchSelection_ = false;
  stopHeadingScroll();
  if (empty_) {
    if(event->key()==Qt::Key_Return || event->key()==Qt::Key_Enter || event->key()==Qt::Key_Space){event->accept();emit openRequested();return;}
    QAbstractScrollArea::keyPressEvent(event);
    return;
  }

  if (previewMode_ && readOnly_ && event->modifiers() == Qt::NoModifier &&
      (event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter || event->key() == Qt::Key_Space)) {
    emit sourceEditRequested(); event->accept(); return;
  }
  if (readOnly_ && (event->matches(QKeySequence::Cut) || event->matches(QKeySequence::Paste) ||
      event->matches(QKeySequence::Undo) || event->matches(QKeySequence::Redo) ||
      event->key() == Qt::Key_Backspace || event->key() == Qt::Key_Delete ||
      event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter ||
      (!event->text().isEmpty() && !(event->modifiers() & (Qt::ControlModifier | Qt::AltModifier))))) {
    event->ignore(); return;
  }
  if (event->text().isEmpty() || (event->modifiers() & (Qt::ControlModifier | Qt::AltModifier)))
    typingContinuation_ = false;
  const bool control = (event->modifiers() & Qt::ControlModifier) != 0;
  const bool shift = (event->modifiers() & Qt::ShiftModifier) != 0;
  const QTextCursor::MoveMode moveMode = shift ? QTextCursor::KeepAnchor : QTextCursor::MoveAnchor;
  const bool editable = blockEditable(cursor_.block());

  if ((event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter) &&
      (event->modifiers() & Qt::AltModifier)) {
    QString href = cursor_.charFormat().anchorHref();
    if (href.isEmpty()) {
      QTextCursor probe = cursor_;
      probe.movePosition(QTextCursor::NextCharacter, QTextCursor::KeepAnchor);
      href = probe.charFormat().anchorHref();
    }
    if (!href.isEmpty()) emit linkActivated(href);
    return;
  }
  const bool alt=event->modifiers() & Qt::AltModifier;
  const bool codeKey=control && alt && event->key()==Qt::Key_C;
  const bool headingKey=control && alt && event->key()>=Qt::Key_0 && event->key()<=Qt::Key_6;
  const bool listKey=control && shift && !alt && (event->key()==Qt::Key_7 || event->key()==Qt::Key_8 || event->key()==Qt::Key_Ampersand || event->key()==Qt::Key_Asterisk);
  const bool quoteKey=control && shift && !alt && event->key()==Qt::Key_B;
  if (!readOnly_ && editable && (headingKey || listKey || quoteKey || codeKey)) {
    if (protectNestedStructure(cursor_)) return;
    QVector<QTextBlock> blocks;
    for(auto block=document_->findBlock(cursor_.selectionStart());block.isValid() && block.position()<=cursor_.selectionEnd();block=block.next()) {
      if(cursor_.hasSelection() && block.position()==cursor_.selectionEnd())break;
      const auto format=block.blockFormat();
      if(format.boolProperty(RawProperty)||format.intProperty(RoleProperty)==RoleTable||format.intProperty(RoleProperty)==RoleImage)continue;
      blocks.append(block); if(!cursor_.hasSelection())break;
    }
    const int level=headingKey?event->key()-Qt::Key_0:0;
    const bool ordered=event->key()==Qt::Key_7 || event->key()==Qt::Key_Ampersand;
    const auto initial=cursor_.blockFormat();
    const bool lift=codeKey?initial.intProperty(RoleProperty)==RoleCode:headingKey?(initial.intProperty(RoleProperty)==RoleHeading && initial.intProperty(HeadingLevelProperty)==level):listKey?(initial.intProperty(RoleProperty)==RoleListItem && initial.boolProperty(ListOrderedProperty)==ordered):initial.intProperty(QuoteDepthProperty)>0;
    cursor_.beginEditBlock(); int number=1;
    for(const auto& block:blocks) {
      auto format=block.blockFormat();
      bool hasImage = false;
      for (auto it = block.begin(); !it.atEnd(); ++it) {
        const auto character = it.fragment().charFormat();
        hasImage |= character.objectType() == SafeInlineImageObjectType || character.isImageFormat();
      }
      // Code serializes plain text. Convert image objects to their Markdown
      // spelling first, within this same undo transaction, rather than losing
      // their alt text, destination and title as an object replacement glyph.
      if (codeKey && !lift && hasImage) {
        QString literal = inlineMarkdown(block);
        literal.replace(QLatin1Char('\n'), QChar::LineSeparator);
        QTextCursor replacement(block);
        replacement.setPosition(block.position() + block.length() - 1, QTextCursor::KeepAnchor);
        replacement.insertText(literal, bodyFormat());
        hasImage = false;
      }
      if(!quoteKey) {
        QTextCursor marker(block);
        for(auto it=block.begin();!it.atEnd();++it){const auto fragment=it.fragment();if(!fragment.charFormat().boolProperty(ListMarkerProperty))break;marker.setPosition(fragment.position());marker.setPosition(fragment.position()+fragment.length(),QTextCursor::KeepAnchor);marker.removeSelectedText();break;}
        for(int property:{ListNumberProperty,ListDepthProperty,ListOrderedProperty,ListDelimiterProperty,NewListItemProperty,HeadingLevelProperty,TaskCheckedProperty,ListLooseProperty})format.clearProperty(property);
        format.setProperty(RoleProperty,RoleBody);format.setTextIndent(0);format.setLineHeight(28,QTextBlockFormat::FixedHeight);format.setTopMargin(16);format.setBottomMargin(0);
      }
      if(quoteKey) {
        format.setProperty(QuoteDepthProperty,lift?qMax(0,format.intProperty(QuoteDepthProperty)-1):format.intProperty(QuoteDepthProperty)+1);
        if (!format.hasProperty(ListDepthProperty))
          format.setTextIndent(format.intProperty(QuoteDepthProperty) == 0 && format.intProperty(RoleProperty) == RoleBody
              ? chineseFirstLineIndent(block.text()) : 0);
      }
      if(codeKey && !lift){format.setProperty(RoleProperty,RoleCode);format.setProperty(CodeLanguageProperty,QString());format.setLineHeight(25.6,QTextBlockFormat::FixedHeight);format.setTopMargin(32);format.setBottomMargin(16);format.setNonBreakableLines(true);}
      if(codeKey && lift){format.setNonBreakableLines(false);format.clearProperty(CodeLanguageProperty);}
      if(headingKey && level && !lift){format.setProperty(RoleProperty,RoleHeading);format.setProperty(HeadingLevelProperty,level);const int size=level==1?30:level==2?24:level==3?20:level==4?18:16;format.setLineHeight(size*1.3,QTextBlockFormat::FixedHeight);format.setTopMargin(block.previous().previous().isValid()?32:0);}
      if(listKey && !lift){format.setProperty(RoleProperty,RoleListItem);format.setProperty(ListDepthProperty,0);format.setProperty(ListOrderedProperty,ordered);format.setProperty(ListNumberProperty,number++);format.setProperty(ListDelimiterProperty,QStringLiteral("."));format.setProperty(NewListItemProperty,true);format.setTopMargin(0);}
      format.setLeftMargin(format.intProperty(QuoteDepthProperty)*18
          + (format.hasProperty(ListDepthProperty) ? 24*(format.intProperty(ListDepthProperty)+1) : 0)
          + (format.intProperty(RoleProperty)==RoleCode ? 16 : 0));
      // A text-only fixed line height clips inline images after a structure
      // change. Keep the normal text height as a minimum for these blocks.
      if (hasImage && format.lineHeightType() == QTextBlockFormat::FixedHeight)
        format.setLineHeight(format.lineHeight(), QTextBlockFormat::MinimumHeight);
      format.setProperty(StructureChangedProperty,true);QTextCursor change(block);change.setBlockFormat(format);
      for(auto it=block.begin();!it.atEnd();++it){const auto fragment=it.fragment();auto character=fragment.charFormat();const bool heading=format.intProperty(RoleProperty)==RoleHeading;const int size=heading?(level==1?30:level==2?24:level==3?20:level==4?18:16):kBody;character.setFont(character.boolProperty(InlineCodeProperty)||format.intProperty(RoleProperty)==RoleCode?theme::monoFont(kCode):theme::uiFont(size));character.setFontWeight(heading||character.boolProperty(MarkBoldProperty)?QFont::DemiBold:QFont::Normal);character.setFontItalic(character.boolProperty(MarkItalicProperty));character.setFontStrikeOut(character.boolProperty(MarkStrikeProperty));character.setForeground(format.intProperty(QuoteDepthProperty)>0?theme::muted():theme::text());QTextCursor span(block);span.setPosition(fragment.position());span.setPosition(fragment.position()+fragment.length(),QTextCursor::KeepAnchor);span.setCharFormat(character);}
      if(listKey && !lift){const QString marker=ordered?QString::number(format.intProperty(ListNumberProperty))+QStringLiteral(". "):QStringLiteral("\u2022  ");format.setTextIndent(-QFontMetricsF(theme::uiFont(kBody)).horizontalAdvance(marker));QTextCursor item(block);item.setBlockFormat(format);auto mark=bodyFormat();mark.setProperty(ListMarkerProperty,true);item.insertText(marker,mark);}
    }
    cursor_.endEditBlock(); resetCaretBlink(); viewport()->update();return;
  }
  if (!readOnly_ && control && !alt && editable && ((!shift && (event->key()==Qt::Key_B || event->key()==Qt::Key_I || event->key()==Qt::Key_E)) || (shift && (event->key()==Qt::Key_X || event->key()==Qt::Key_S)))) {
    QTextCharFormat format;
    const int property=event->key()==Qt::Key_E?InlineCodeProperty:event->key()==Qt::Key_B?MarkBoldProperty:event->key()==Qt::Key_I?MarkItalicProperty:MarkStrikeProperty;
    const bool enabled=!cursor_.charFormat().boolProperty(property);format.setProperty(property,enabled);
    if(property==InlineCodeProperty){format.setFont(enabled?theme::monoFont(kCode):theme::uiFont(kBody));if(enabled){for(int mark:{MarkBoldProperty,MarkItalicProperty,MarkStrikeProperty})format.setProperty(mark,false);format.setFontWeight(QFont::Normal);format.setFontItalic(false);format.setFontStrikeOut(false);format.setAnchor(false);format.setAnchorHref(QString());}}
    if(property==MarkBoldProperty)format.setFontWeight(enabled||cursor_.blockFormat().intProperty(RoleProperty)==RoleHeading?QFont::DemiBold:QFont::Normal);
    if(property==MarkItalicProperty)format.setFontItalic(enabled);
    if(property==MarkStrikeProperty)format.setFontStrikeOut(enabled);
    cursor_.mergeCharFormat(format);viewport()->update();return;
  }
  if(!readOnly_ && editable && cursor_.blockFormat().intProperty(RoleProperty)==RoleCode && !cursor_.blockFormat().boolProperty(RawProperty)) {
    const bool atStart=cursor_.position()==cursor_.block().position();
    const bool atEnd=cursor_.position()==cursor_.block().position()+cursor_.block().length()-1;
    if(event->key()==Qt::Key_Backspace && !cursor_.hasSelection() && atStart && (cursor_.block().text().isEmpty() || !cursor_.block().previous().previous().isValid())) {
      QKeyEvent toggle(QEvent::KeyPress,Qt::Key_C,Qt::ControlModifier|Qt::AltModifier);keyPressEvent(&toggle);return;
    }
    if(!cursor_.hasSelection() && !shift && !control && ((event->key()==Qt::Key_Up && atStart && !cursor_.block().previous().previous().isValid()) || (event->key()==Qt::Key_Down && atEnd && (!cursor_.block().next().isValid() || segmentOf(cursor_.block().next())<0)))) {
      if (protectNestedStructure(cursor_)) return;
      const bool before=event->key()==Qt::Key_Up;cursor_.beginEditBlock();auto original=cursor_.blockFormat();original.setProperty(StructureChangedProperty,true);auto body=bodyBlock();body.setProperty(NodeProperty,original.intProperty(NodeProperty));body.setProperty(SegmentProperty,segmentOf(cursor_.block()));body.setProperty(StructureChangedProperty,true);
      cursor_.insertBlock(before?original:body,before?cursor_.charFormat():bodyFormat());if(before){cursor_.movePosition(QTextCursor::PreviousBlock);cursor_.setBlockFormat(body);cursor_.setCharFormat(bodyFormat());}cursor_.endEditBlock();ensureCaretVisible();return;
    }
    if(event->key()==Qt::Key_Tab || event->key()==Qt::Key_Backtab) {
      if (replacesBlockStructure(cursor_) && protectNestedStructure(cursor_)) return;
    const bool outdent=shift||event->key()==Qt::Key_Backtab;
      if(cursor_.hasSelection()) {
        QString selected=cursor_.selectedText();selected.replace(QChar::ParagraphSeparator,QChar::LineSeparator);auto lines=selected.split(QChar::LineSeparator);
        for(auto& line:lines){if(outdent){int count=0;while(count<2 && count<line.size() && line.at(count)==QLatin1Char(' '))++count;line.remove(0,count);}else line.prepend(QStringLiteral("  "));}
        cursor_.beginEditBlock();cursor_.insertText(lines.join(QChar::LineSeparator));cursor_.endEditBlock();
      } else if(!outdent)insertTyped(QStringLiteral("  "));
      else {
        const auto block=cursor_.block();const QString text=block.text();const int offset=cursor_.position()-block.position();const int start=offset?text.lastIndexOf(QChar::LineSeparator,offset-1)+1:0;
        int count=0;while(count<2 && start+count<text.size() && text.at(start+count)==QLatin1Char(' '))++count;
        if(count){QTextCursor line(block);line.setPosition(block.position()+start);line.setPosition(block.position()+start+count,QTextCursor::KeepAnchor);line.removeSelectedText();}
      }
      ensureCaretVisible();return;
    }
  }
  if ((event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter) && control && editable) {
    if (replacesBlockStructure(cursor_) && protectNestedStructure(cursor_)) return;
    if(cursor_.blockFormat().intProperty(RoleProperty)!=RoleCode){cursor_.insertText(QString(QChar::LineSeparator));resetCaretBlink();ensureCaretVisible();return;}
    if (protectNestedStructure(cursor_)) return;
    QTextBlockFormat format = bodyBlock();
    format.setProperty(StructureChangedProperty,true);
    format.setProperty(NodeProperty, cursor_.blockFormat().intProperty(NodeProperty));
    format.setProperty(SegmentProperty, segmentOf(cursor_.block()));
    cursor_.movePosition(QTextCursor::EndOfBlock);
    cursor_.insertBlock(format, bodyFormat()); resetCaretBlink(); ensureCaretVisible(); return;
  }
  if ((event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter) && shift && editable) {
    if (replacesBlockStructure(cursor_) && protectNestedStructure(cursor_)) return;
    cursor_.insertText(QString(QChar::LineSeparator)); resetCaretBlink(); ensureCaretVisible(); return;
  }
  if ((event->key() == Qt::Key_Tab || event->key() == Qt::Key_Backtab) && editable && cursor_.currentTable()) {
    QTextTable* table = cursor_.currentTable();
    const auto cell = table->cellAt(cursor_);
    const bool backward = shift || event->key() == Qt::Key_Backtab;
    int index = cell.row() * table->columns() + cell.column() + (backward ? -1 : 1);
    if (index < 0) return;
    if (index >= table->rows() * table->columns()) {
      cursor_.beginEditBlock();
      const auto prototype = cursor_.blockFormat();
      table->appendRows(1);
      for (int column = 0; column < table->columns(); ++column) {
        QTextCursor cellCursor = table->cellAt(table->rows()-1,column).firstCursorPosition();
        auto format = prototype; format.setProperty(TableRowProperty, table->rows()-1); format.setProperty(TableColumnProperty, column);
        cellCursor.setBlockFormat(format); cellCursor.setCharFormat(bodyFormat());
      }
      cursor_.endEditBlock();
    }
    cursor_ = table->cellAt(index / table->columns(), index % table->columns()).lastCursorPosition();
    cursor_.movePosition(QTextCursor::StartOfBlock); resetCaretBlink(); ensureCaretVisible(); return;
  }
  if ((event->key() == Qt::Key_Tab || event->key() == Qt::Key_Backtab) && editable && cursor_.blockFormat().intProperty(RoleProperty) == RoleListItem) {
    changeListLevel(shift || event->key() == Qt::Key_Backtab ? -1 : 1); return;
  }
  if (event->key() == Qt::Key_Tab && editable && cursor_.blockFormat().intProperty(RoleProperty) == RoleCode) {
    insertTyped(QStringLiteral("  ")); return;
  }
  if (event->matches(QKeySequence::Copy)) {
    copySelection();
    return;
  }
  if (event->matches(QKeySequence::Cut)) {
    if (cursor_.hasSelection()) {
      copySelection();
      deleteBackward();
      resetCaretBlink();
      ensureCaretVisible();
      viewport()->update();
    }
    return;
  }
  if (event->matches(QKeySequence::Paste)) {
    if (editable || cursor_.hasSelection()) insertTyped(QApplication::clipboard()->text());
    return;
  }
  if (event->matches(QKeySequence::Undo) && !(control && shift && event->key()==Qt::Key_Z)) {
    {
      document_->undo(&cursor_);
      resetCaretBlink();
      ensureCaretVisible();
      viewport()->update();
    }
    return;
  }
  if (!readOnly_ && (event->matches(QKeySequence::Redo) || (control && shift && event->key()==Qt::Key_Z))) {
    {
      document_->redo(&cursor_);
      resetCaretBlink();
      ensureCaretVisible();
      viewport()->update();
    }
    return;
  }
  if (event->matches(QKeySequence::SelectAll)) {
    QTextCursor cursor(document_);
    cursor.movePosition(QTextCursor::NextBlock);
    cursor.movePosition(QTextCursor::End, QTextCursor::KeepAnchor);
    cursor_ = cursor;
    viewport()->update();
    return;
  }
  if (event->key() == Qt::Key_Escape) {
    if (cursor_.hasSelection()) {
      cursor_.clearSelection();
      viewport()->update();
    }
    return;
  }
  if (event->key() == Qt::Key_Left) {
    moveCursor(control ? QTextCursor::WordLeft : QTextCursor::Left, moveMode);
    return;
  }
  if (event->key() == Qt::Key_Right) {
    moveCursor(control ? QTextCursor::WordRight : QTextCursor::Right, moveMode);
    return;
  }
  if (event->key() == Qt::Key_Up) {
    moveCursor(QTextCursor::Up, moveMode);
    return;
  }
  if (event->key() == Qt::Key_Down) {
    moveCursor(QTextCursor::Down, moveMode);
    return;
  }
  if (event->key() == Qt::Key_Home && !control) {
    moveCursor(QTextCursor::StartOfLine, moveMode);
    return;
  }
  if (event->key() == Qt::Key_End && !control) {
    moveCursor(QTextCursor::EndOfLine, moveMode);
    return;
  }
  if (event->key() == Qt::Key_Home && control) {
    moveCursor(QTextCursor::Start, moveMode);
    if (segmentOf(cursor_.block()) < 0) moveCursor(QTextCursor::NextBlock, moveMode);
    return;
  }
  if (event->key() == Qt::Key_End && control) {
    moveCursor(QTextCursor::End, moveMode);
    return;
  }
  if (event->key() == Qt::Key_Backspace) {
    if (control && !cursor_.hasSelection()) cursor_.movePosition(QTextCursor::PreviousWord, QTextCursor::KeepAnchor);
    deleteBackward();
    return;
  }
  if (event->key() == Qt::Key_Delete) {
    if (control && !cursor_.hasSelection()) cursor_.movePosition(QTextCursor::NextWord, QTextCursor::KeepAnchor);
    deleteForward();
    return;
  }
  if ((event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter) && !control) {
    splitBlockAtCursor();
    return;
  }
  if (event->key() == Qt::Key_PageDown || event->key() == Qt::Key_PageUp) {
    const bool down = event->key() == Qt::Key_PageDown;
    cursor_.movePosition(down ? QTextCursor::Down : QTextCursor::Up, moveMode, qMax(1, viewport()->height() / 28 - 1));
    verticalScrollBar()->setValue(verticalScrollBar()->value() + (down ? 1 : -1) * viewport()->height() * 9 / 10);
    resetCaretBlink(); ensureCaretVisible(); return;
  }
  if (!control && !event->text().isEmpty() && event->text().at(0).isPrint()) {
    insertTyped(event->text());
    return;
  }
  QAbstractScrollArea::keyPressEvent(event);
}

QJsonObject DocumentView::selectionMime() const {
  if(!cursor_.hasSelection())return {};
  bool hasImage = false;
  for (QTextBlock block = document_->findBlock(cursor_.selectionStart()); block.isValid() && block.position() < cursor_.selectionEnd(); block = block.next())
    for (auto it = block.begin(); !it.atEnd(); ++it) {
      const auto fragment = it.fragment();
      if (fragment.position() < cursor_.selectionEnd() && fragment.position() + fragment.length() > cursor_.selectionStart() &&
          fragment.charFormat().hasProperty(ImageSourceProperty)) hasImage = true;
    }
  if (hasImage) {
    // Export semantic images, never the painted failure label. The isolated
    // document cannot load filesystem/network resources while producing HTML.
    SafeImageDocument copy(nullptr); QTextCursor insertion(&copy);
    insertion.insertFragment(QTextDocumentFragment(cursor_));
    struct ImageExport { int position; QTextCharFormat format; };
    QVector<ImageExport> images;
    for (QTextBlock block = copy.begin(); block.isValid(); block = block.next())
      for (auto it = block.begin(); !it.atEnd(); ++it) {
        const auto fragment = it.fragment();
        if (fragment.charFormat().hasProperty(ImageSourceProperty))
          for (int i = 0; i < fragment.length(); ++i)
            images.append({fragment.position() + i, fragment.charFormat()});
      }
    QString text = copy.toPlainText();
    for (int i = images.size() - 1; i >= 0; --i) {
      const auto& item = images[i]; const auto& format = item.format;
      const QString source = format.stringProperty(ImageSourceProperty);
      const QString alt = format.stringProperty(ImageAltProperty);
      const QString title = format.stringProperty(ImageTitleProperty);
      // Match ProseMirror's textBetween default: image leaves contribute no
      // plain text, while HTML carries the complete semantic image.
      text.remove(item.position, 1);
      QTextImageFormat exported; exported.setName(source);
      exported.setProperty(QTextFormat::ImageAltText, alt);
      exported.setProperty(QTextFormat::ImageTitle, title);
      QTextCursor image(&copy); image.setPosition(item.position);
      image.movePosition(QTextCursor::NextCharacter, QTextCursor::KeepAnchor); image.setCharFormat(exported);
    }
    QString html = copy.toHtml();
    // Legacy LocalImage exports data-local-src, not a loadable src. Preserve
    // that inert contract even for rejected schemes; Qt escaped the value.
    html.replace(QRegularExpression(QStringLiteral("(<img\\b[^>]*?)\\bsrc=")), QStringLiteral("\\1data-local-src="));
    return {{"text", text}, {"html", html}};
  }
  QString text=cursor_.selectedText();text.replace(QChar::ParagraphSeparator,QLatin1Char('\n'));text.replace(QChar::LineSeparator,QLatin1Char('\n'));
  return {{"text",text},{"html",QTextDocumentFragment(cursor_).toHtml()}};
}

void DocumentView::copySelection() {
  const auto data=selectionMime();if(data.isEmpty())return;
  auto* mime=new QMimeData;mime->setText(data.value("text").toString());mime->setHtml(data.value("html").toString());
  QApplication::clipboard()->setMimeData(mime);
}

int DocumentView::segmentOf(const QTextBlock& block) const {
  if (!block.isValid()) return -1;
  return block.blockFormat().hasProperty(SegmentProperty) ? block.blockFormat().intProperty(SegmentProperty) : -1;
}

bool DocumentView::blockEditable(const QTextBlock& block) const {
  if (readOnly_) return false;
  const int segment = segmentOf(block);
  return segment >= 0 && editableSegments_.contains(segment);
}

QString DocumentView::inlineMarkdown(const QTextBlock& block) const {
  QString out;
  QVector<QPair<QString,QTextCharFormat>> runs;
  auto sameMarks=[](const QTextCharFormat& a,const QTextCharFormat& b) {
    for(int property:{InlineCodeProperty,MarkBoldProperty,MarkItalicProperty,MarkStrikeProperty,SoftBreakProperty,ListMarkerProperty})
      if(a.boolProperty(property)!=b.boolProperty(property)) return false;
    return a.isAnchor()==b.isAnchor() && a.anchorHref()==b.anchorHref() && a.stringProperty(LinkTitleProperty)==b.stringProperty(LinkTitleProperty) &&
        a.property(LinkReferenceProperty)==b.property(LinkReferenceProperty);
  };
  for (auto iterator = block.begin(); !iterator.atEnd(); ++iterator) {
    const auto fragment=iterator.fragment();
    if(!fragment.isValid())continue;
    const auto format=fragment.charFormat();
    if(!runs.isEmpty() && !format.hasProperty(ImageSourceProperty) && !runs.last().second.hasProperty(ImageSourceProperty) && sameMarks(format,runs.last().second))
      runs.last().first+=fragment.text();
    else runs.append({fragment.text(),format});
  }
  QString referenceText, referenceHref;
  QByteArray currentReferenceFingerprint;
  QJsonObject activeReference;
  const auto flushReference = [&] {
    if (!activeReference.isEmpty()) {
      const auto original = originalReferenceFingerprints_.constFind(referenceKey(activeReference, block.blockFormat().intProperty(NodeProperty)));
      const QString label = original != originalReferenceFingerprints_.cend() && original.value() == QCryptographicHash::hash(currentReferenceFingerprint, QCryptographicHash::Sha256)
          ? activeReference.value("textSource").toString() : referenceText;
      out += referenceMarkdown(label, activeReference);
    }
    currentReferenceFingerprint.clear();
    referenceText.clear(); referenceHref.clear(); activeReference = QJsonObject();
  };
  for (const auto& run : runs) {
    QString text = run.first;
    const QTextCharFormat format = run.second;
    if (text.isEmpty() || format.boolProperty(ListMarkerProperty)) continue;
    const bool code = format.boolProperty(InlineCodeProperty);
    // Visual heading/table weight is not an inline Markdown mark.
    const bool bold = format.boolProperty(MarkBoldProperty);
    const bool italic = format.boolProperty(MarkItalicProperty);
    const bool strike = format.boolProperty(MarkStrikeProperty);
    const QString href = format.anchorHref();
    if (format.hasProperty(ImageSourceProperty)) {
      const QString alt = format.hasProperty(ImageAltSourceProperty) &&
          format.stringProperty(ImageAltProperty) == format.stringProperty(ImageAltOriginalProperty)
          ? format.stringProperty(ImageAltSourceProperty) : escapedText(format.stringProperty(ImageAltProperty));
      const QJsonObject reference = QJsonObject::fromVariantMap(format.property(ImageReferenceProperty).toMap());
      const QString imageMarkdown = reference.isEmpty()
          ? QStringLiteral("![") + alt + QStringLiteral("](") + destination(format.stringProperty(ImageSourceProperty)) +
              titleSuffix(format.stringProperty(ImageTitleProperty)) + QLatin1Char(')')
          : QLatin1Char('!') + referenceMarkdown(alt, reference);
      // QTextDocument may merge adjacent identical image atoms into one format
      // fragment. Serialize every object, not just every fragment, and retain
      // any ordinary text rather than silently treating it as image metadata.
      text = escapedText(text);
      text.replace(QString(QChar::ObjectReplacementCharacter), imageMarkdown);
    } else if (code) {
      int size = 1, run = 0;
      for (QChar c : text) { run = c == '`' ? run + 1 : 0; size = qMax(size, run + 1); }
      const QString fence(size, '`');
      const bool pad = text.startsWith('`') || text.endsWith('`') ||
                       (text.startsWith(' ') && text.endsWith(' ') && !text.trimmed().isEmpty());
      text = fence + (pad ? " " : "") + text + (pad ? " " : "") + fence;
    } else {
      text = escapedText(text);
      text.replace(QChar::LineSeparator, format.boolProperty(SoftBreakProperty) ?
                   QStringLiteral("\n") : QStringLiteral("  \n"));
      text.replace(QChar::ParagraphSeparator, QLatin1Char('\n'));
    }
    if (bold) text = wrapMark(text, QStringLiteral("**"));
    if (italic) text = wrapMark(text, QStringLiteral("*"));
    if (strike) text = wrapMark(text, QStringLiteral("~~"));
    const QJsonObject reference = QJsonObject::fromVariantMap(format.property(LinkReferenceProperty).toMap());
    if (format.isAnchor() && !reference.isEmpty()) {
      if (activeReference != reference || referenceHref != href) {
        flushReference(); activeReference = reference; referenceHref = href;
      }
      referenceText += text;
      currentReferenceFingerprint += referenceFingerprint(run.first, format);
    } else {
      flushReference();
      if (format.isAnchor()) text = QLatin1Char('[') + text + QStringLiteral("](") +
          destination(href) + titleSuffix(format.stringProperty(LinkTitleProperty)) + QLatin1Char(')');
      out += text;
    }
  }
  flushReference();
  return out;
}

QString DocumentView::serializeNode(const QJsonObject& node) const {
  const QString type = node.value("type").toString();
  const int id = node.value("nodeId").toInt(-1);
  if (type == "raw" && node.value("hidden").toBool()) return node.value("text").toString();
  if (type == "quote") {
    QStringList children;
    for (const auto& child : node.value("blocks").toArray()) {
      const QString text = serializeNode(child.toObject());
      if (!text.isEmpty()) children.append(text);
    }
    if (children.isEmpty()) return {};
    QString result = children.join(QStringLiteral("\n\n"));
    result.replace(QStringLiteral("\n"), QStringLiteral("\n> "));
    return QStringLiteral("> ") + result;
  }
  if (type == "list") {
    QStringList items;
    const bool ordered = node.value("ordered").toBool();
    int number = node.value("start").toInt(1);
    const QString delimiter = node.value("delimiter").toString(QStringLiteral("."));
    for (const auto& item : node.value("items").toArray()) {
      QString text;
      for (const auto& child : item.toArray()) {
        const QString part = serializeNode(child.toObject());
        if (part.isEmpty()) continue;
        if (!text.isEmpty()) text += child.toObject().value("type").toString() == "list" ? QStringLiteral("\n") : QStringLiteral("\n\n");
        text += part;
      }
      if (text.isEmpty()) {
        // Preserve a still-present empty item, but never resurrect deleted nodes.
        std::function<bool(const QJsonObject&)> hasLiveBlock = [&](const QJsonObject& child) {
          const int childId = child.value("nodeId").toInt(-1);
          for (const auto& block : nodeBlocks_.value(childId))
            if (block.isValid() && block.blockFormat().intProperty(NodeProperty) == childId &&
                block.blockFormat().hasProperty(ListDepthProperty)) return true;
          for (const auto& nested : child.value("blocks").toArray()) if (hasLiveBlock(nested.toObject())) return true;
          for (const auto& nestedItem : child.value("items").toArray())
            for (const auto& nested : nestedItem.toArray()) if (hasLiveBlock(nested.toObject())) return true;
          return false;
        };
        bool present = false;
        for (const auto& child : item.toArray()) if (hasLiveBlock(child.toObject())) { present = true; break; }
        if (!present) continue;
      }
      const QString marker = ordered ? QString::number(number++) + delimiter + QLatin1Char(' ') : QStringLiteral("- ");
      text.replace(QStringLiteral("\n"), QLatin1Char('\n') + QString(marker.size(), QLatin1Char(' ')));
      const QStringList splits = text.split(QChar(0xFDD0));
      for (int split = 0; split < splits.size(); ++split) {
        const QString currentMarker = split == 0 ? marker : ordered ? QString::number(number++) + delimiter + QLatin1Char(' ') : QStringLiteral("- ");
        items.append(currentMarker + splits.at(split));
      }
    }
    return items.join(node.value("loose").toBool() ? QStringLiteral("\n\n") : QStringLiteral("\n"));
  }
  if (type == "table") {
    QMap<QPair<int, int>, QStringList> cells;
    int maxRow = -1, maxColumn = -1;
    for (const QTextBlock& block : nodeBlocks_.value(id)) {
      const QTextBlockFormat format = block.blockFormat();
      if (!format.hasProperty(NodeProperty) || format.intProperty(NodeProperty) != id ||
          !format.hasProperty(TableRowProperty)) continue;
      const int row = format.intProperty(TableRowProperty), column = format.intProperty(TableColumnProperty);
      QString text = inlineMarkdown(block);
      text.replace(QStringLiteral("  \n"), QStringLiteral("<br>"));
      text.replace(QLatin1Char('\n'), QStringLiteral("<br>"));
      text.replace(QLatin1Char('|'), QStringLiteral("\\|"));
      cells[{row, column}].append(text);
      maxRow = qMax(maxRow, row); maxColumn = qMax(maxColumn, column);
    }
    if (maxRow < 0) return {};
    QStringList lines;
    for (int row = 0; row <= maxRow; ++row) {
      QStringList values;
      for (int col = 0; col <= maxColumn; ++col) values.append(cells.value({row, col}).join(QStringLiteral("<br>")));
      lines.append(QStringLiteral("| ") + values.join(QStringLiteral(" | ")) + QStringLiteral(" |"));
      if (row == 0) {
        values.clear();
        const QJsonArray align = node.value("align").toArray();
        for (int col = 0; col <= maxColumn; ++col) {
          const QString a = col < align.size() ? align.at(col).toString() : QString();
          values.append(a == "left" ? ":---" : a == "center" ? ":---:" : a == "right" ? "---:" : "---");
        }
        lines.append(QStringLiteral("| ") + values.join(QStringLiteral(" | ")) + QStringLiteral(" |"));
      }
    }
    return lines.join(QLatin1Char('\n'));
  }
  QStringList parts;
  for (const QTextBlock& block : nodeBlocks_.value(id)) {
    const QTextBlockFormat format = block.blockFormat();
    if (!format.hasProperty(NodeProperty) || format.intProperty(NodeProperty) != id) continue;
    const int role = format.intProperty(RoleProperty);
    QString text = inlineMarkdown(block);
    if (role == RoleCode) {
      text = block.text();
      text.replace(QChar::LineSeparator, QLatin1Char('\n'));
      if (!format.boolProperty(RawProperty)) text = fenced(text, format.stringProperty(CodeLanguageProperty));
    } else if (role == RoleRule) {
      text = QStringLiteral("---");
    } else if (role == RoleHeading) {
      text = QString(qBound(1, format.intProperty(HeadingLevelProperty), 6), QLatin1Char('#')) + QLatin1Char(' ') + text;
    } else if (role != RoleImage && !(text.isEmpty() && format.hasProperty(ListDepthProperty))) {
      text = paragraphMarkdown(text);
    }
    if (format.hasProperty(TaskCheckedProperty))
      text.prepend(format.boolProperty(TaskCheckedProperty) ? QStringLiteral("[x] ") : QStringLiteral("[ ] "));
    if (format.boolProperty(NewListItemProperty) && !parts.isEmpty()) {
      parts.last() += QChar(0xFDD0) + text;
    } else parts.append(text);
  }
  return parts.join(QStringLiteral("\n\n"));
}

QString DocumentView::serializeSegment(int segment) const {
  const QJsonObject model = segmentModels_.value(segment);
  if (model.value("type").toString() == "raw" && model.value("hidden").toBool()) {
    QString original = model.value("text").toString();
    const QString appended = serializeFlatSegment(segment);
    if (!appended.isEmpty()) {
      if (!original.endsWith(QLatin1Char('\n'))) original += QLatin1Char('\n');
      if (!original.endsWith(QStringLiteral("\n\n"))) original += QLatin1Char('\n');
      original += appended;
    }
    return original;
  }
  const auto blocks = segmentBlocks_.value(segment);
  for (const QTextBlock& block : blocks)
    if (block.blockFormat().boolProperty(StructureChangedProperty)) return serializeFlatSegment(segment);
  for (const QTextBlock& block : blocks) {
    if (!block.blockFormat().boolProperty(FlattenProperty)) continue;
    if (block.text().isEmpty() && !block.next().isValid()) return {};
    return serializeNode(QJsonObject{{"type", "paragraph"}, {"nodeId", block.blockFormat().intProperty(NodeProperty)}});
  }
  return serializeNode(segmentModels_.value(segment));
}

QVector<QPair<int, QString>> DocumentView::pendingEdits() const {
  QVector<QPair<int, QString>> edits;
  for (int segment : dirtySegments_) {
    const QString markdown = serializeSegment(segment);
    if (markdown != baselineSegments_.value(segment)) edits.append({segment, markdown});
  }
  std::sort(edits.begin(), edits.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  return edits;
}

void DocumentView::snapshotBlocks() {
  blockSnapshot_.clear(); nodeBlocks_.clear(); segmentBlocks_.clear();
  for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
    const int segment = segmentOf(block);
    blockSnapshot_.append({block.position(), block.position() + block.length() - 1, segment,block.blockFormat().hasProperty(NodeProperty)?block.blockFormat().intProperty(NodeProperty):-1,block.blockFormat().intProperty(RoleProperty)});
    if(segment>=0)segmentBlocks_[segment].append(block);
    const auto format=block.blockFormat();
    if(format.hasProperty(NodeProperty))nodeBlocks_[format.intProperty(NodeProperty)].append(block);
  }
}

void DocumentView::refreshAfterEdit() {
  if (building_ || empty_) return;
  const bool previous = suppressEdits_;
  suppressEdits_ = true;
  if (refreshParagraphIndents(fullGeometryPending_ ? QTextBlock() : pendingGeometryBlock_)) fullGeometryPending_ = true;
  if(!fullGeometryPending_ && pendingGeometryBlock_.isValid())refreshBlockGeometry(pendingGeometryBlock_);
  else relayout();
  pendingGeometryBlock_=QTextBlock();fullGeometryPending_=false;
  suppressEdits_ = previous;
  applySearchHighlight(query_);
  ensureCaretVisible();
}

QString DocumentView::selectedText() const {
  if (isComposing() || !cursor_.hasSelection() ||
      document_->findBlock(cursor_.selectionStart()) != document_->findBlock(cursor_.selectionEnd())) return {};
  QString text = cursor_.selectedText();
  if (text.contains(QChar::ObjectReplacementCharacter) || text.contains(QChar::LineSeparator)) return {};
  return text;
}

void DocumentView::replaceRange(QTextCursor& range, const QString& text) {
  QTextCharFormat format;
  bool first = true;
  for (int position = range.selectionStart(); position < range.selectionEnd(); ++position) {
    QTextCursor probe(document_); probe.setPosition(position); probe.movePosition(QTextCursor::NextCharacter, QTextCursor::KeepAnchor);
    if (first) { format = probe.charFormat(); first = false; }
    else {
      const auto properties = format.properties();
      for (auto it = properties.cbegin(); it != properties.cend(); ++it)
        if (probe.charFormat().property(it.key()) != it.value()) format.clearProperty(it.key());
    }
  }
  if (first) format = range.charFormat();
  format.clearProperty(ListMarkerProperty);
  format.clearProperty(ImageSourceProperty);
  format.clearProperty(ImageAltProperty);
  format.clearProperty(ImageTitleProperty);
  format.clearProperty(ImageReferenceProperty);
  format.clearProperty(ImageAltSourceProperty);
  format.clearProperty(ImageAltOriginalProperty);
  range.insertText(text, format);
}

bool DocumentView::replaceCurrent(const QString& replacement) {
  if (isComposing() || activeMatch_ < 0 || activeMatch_ >= matches_.size()) return false;
  QTextCursor range = matches_.at(activeMatch_);
  if (replacesBlockStructure(range, replacement) && protectNestedStructure(range)) return false;
  const bool changed = range.selectedText() != replacement;
  const int delta = changed ? replacement.size() - (range.selectionEnd() - range.selectionStart()) : 0;
  QVector<QPair<int,int>> following;
  for (int i = activeMatch_ + 1; i < matches_.size(); ++i)
    following.append({matches_[i].selectionStart() + delta, matches_[i].selectionEnd() + delta});
  if (changed) {
    range.beginEditBlock(); replaceRange(range, replacement); range.endEditBlock();
    cursor_ = range;
    refreshAfterEdit();
  }
  // Select only a surviving original range, never a match introduced by the
  // replacement. Exact endpoints matter when previously adjacent matches merge.
  activeMatch_ = -1;
  for (const auto& old : following) {
    for (int i = 0; i < matches_.size(); ++i) {
      if (matches_[i].selectionStart() == old.first && matches_[i].selectionEnd() == old.second) {
        focusSearchResult(i); return changed;
      }
    }
  }
  viewport()->update();
  return changed;
}

int DocumentView::replaceAll(const QString& replacement) {
  if (isComposing()) return 0;
  const auto ranges = matches_;
  for (const auto& range : ranges)
    if (replacesBlockStructure(range, replacement) && protectNestedStructure(range)) return 0;
  const int changes = replacementChangeCount(replacement);
  if (changes == 0) return 0;
  QTextCursor transaction(document_); transaction.beginEditBlock();
  for (int i = ranges.size() - 1; i >= 0; --i) {
    QTextCursor range = ranges.at(i); if (range.selectedText() != replacement) replaceRange(range, replacement);
  }
  transaction.endEditBlock();
  refreshAfterEdit();
  return changes;
}

QRectF DocumentView::caretRectangle() const {
  const QTextBlock block = isComposing() && preeditBlock_.isValid() ? preeditBlock_ : cursor_.block();
  if (!block.isValid()) return {};
  QTextLayout* layout = block.layout();
  if (layout == nullptr) return {};
  const int position = isComposing() && block == preeditBlock_
      ? preeditPosition_ + preeditCursor_
      : qBound(0, cursor_.position() - block.position(), qMax(0, block.length() - 1));
  const QTextLine line = layout->lineForTextPosition(position);
  if (!line.isValid()) return {};
  qreal x = document_->documentLayout()->blockBoundingRect(block).left() + line.cursorToX(position);
  for (const auto& region : horizontalRegions_)
    if (region.node == block.blockFormat().intProperty(NodeProperty)) { x -= region.scroll; break; }
  const QRectF blockRect = document_->documentLayout()->blockBoundingRect(block);
  return QRectF(x, blockRect.top() + line.y(), 1.0, line.height());
}

void DocumentView::paintCaret(QPainter& painter) {
  if (!hasFocus() || empty_ || dragging_ || (isComposing() ? !preeditCursorVisible_ : !caretOn_)) return;
  const QRectF caret = caretRectangle();
  if (caret.isEmpty() || caret.top() < -60) return;
  // The preedit string belongs to QTextLayout, not an overlay: trailing text
  // must move and wrap while the transient string stays out of Markdown/undo.
  painter.fillRect(QRectF(caret.left(), caret.top(), 1.0, caret.height()),
                   isComposing() && preeditCursorColor_.isValid() ? preeditCursorColor_ : theme::text());
}

void DocumentView::resetCaretBlink() {
  caretOn_ = true;
  if (caretTimer_ != nullptr) caretTimer_->start();
  viewport()->update();
}

void DocumentView::ensureCaretVisible() {
  if (empty_) return;
  const int node = cursor_.blockFormat().intProperty(NodeProperty);
  if (hasFocus() && rawSurfaces_.contains(node) && !rawSurfaces_[node].source) {
    const QTextCursor saved = cursor_;
    setRawSourceVisible(node, true); cursor_ = saved;
  }
  QRectF caret = caretRectangle();
  if (caret.isEmpty()) return;
  for (const auto& region : horizontalRegions_) {
    if (region.node != cursor_.blockFormat().intProperty(NodeProperty) || region.maximum <= 0) continue;
    qreal offset = region.scroll;
    if (caret.left() < 16) offset = qMax<qreal>(0, offset + caret.left() - 16);
    else if (caret.left() > region.rect.width() - 24) offset = qMin(region.maximum, offset + caret.left() - region.rect.width() + 24);
    if (offset != region.scroll) { horizontalOffsets_[region.node] = offset; rebuildDecorations(); caret = caretRectangle(); }
    break;
  }
  const int top = verticalScrollBar()->value();
  const int height = viewport()->height();
  const int y = qRound(caret.top() + topPadding());
  if (y < top + 48) {
    verticalScrollBar()->setValue(qMax(0, y - 48));
  } else if (y + 28 > top + height - 48) {
    verticalScrollBar()->setValue(y + 28 - height + 48);
  }
}

void DocumentView::moveCursor(QTextCursor::MoveOperation operation, QTextCursor::MoveMode mode) {
  QTextCursor next = cursor_;
  if (next.hasSelection() && mode == QTextCursor::MoveAnchor &&
      (operation == QTextCursor::Left || operation == QTextCursor::Right)) {
    next.setPosition(operation == QTextCursor::Left ? next.selectionStart() : next.selectionEnd());
  } else next.movePosition(operation, mode);
  cursor_ = next;
  resetCaretBlink();
  ensureCaretVisible();
}


bool DocumentView::protectNestedStructure(const QTextCursor& range) {
  std::function<bool(const QJsonObject&, int, int)> risky = [&](const QJsonObject& node, int lists, int quotes) {
    const QString type = node.value("type").toString();
    lists += type == "list"; quotes += type == "quote";
    if (lists >= 2 && quotes > 0) return true;
    for (const auto& child : node.value("blocks").toArray()) if (risky(child.toObject(), lists, quotes)) return true;
    for (const auto& item : node.value("items").toArray())
      for (const auto& child : item.toArray()) if (risky(child.toObject(), lists, quotes)) return true;
    return false;
  };
  QSet<int> checked;
  for (QTextBlock block = document_->findBlock(range.selectionStart()); block.isValid() && block.position() <= range.selectionEnd(); block = block.next()) {
    const int segment = segmentOf(block);
    if (!checked.contains(segment)) {
      checked.insert(segment);
      if (risky(segmentModels_.value(segment), 0, 0)) {
        QToolTip::showText(viewport()->mapToGlobal(QPoint(24, 24)),
            QStringLiteral("此嵌套结构请在源码模式中调整，以保留原有层级。普通文字和任务勾选仍可直接编辑。"), this, QRect(), 6000);
        return true;
      }
    }
    if (!range.hasSelection()) break;
  }
  return false;
}

void DocumentView::insertTyped(const QString& text) {
  if (text.isEmpty()) return;
  const bool inlineNewlines = cursor_.blockFormat().intProperty(RoleProperty) == RoleCode ||
      cursor_.blockFormat().intProperty(RoleProperty) == RoleTable;
  if (replacesBlockStructure(cursor_, inlineNewlines ? QString() : text) && protectNestedStructure(cursor_)) return;
  if (!blockEditable(cursor_.block()) && !cursor_.hasSelection()) return;
  const bool join = typingContinuation_ && !cursor_.hasSelection() && cursor_.position() == lastTypingPosition_;
  if (join) cursor_.joinPreviousEditBlock(); else cursor_.beginEditBlock();
  // Preserve a replaced label only when every selected character belongs to
  // one link identity, excluding plain text and distinct reference sourceIds.
  QTextCharFormat selectedFormat;
  const bool replacedSelection = cursor_.hasSelection();
  bool selectedLink = replacedSelection;
  bool firstSelected = true;
  for (int position = cursor_.selectionStart(); selectedLink && position < cursor_.selectionEnd(); ++position) {
    QTextCursor probe(document_);
    probe.setPosition(position);
    probe.movePosition(QTextCursor::NextCharacter, QTextCursor::KeepAnchor);
    const QTextCharFormat candidate = probe.charFormat();
    if (!candidate.isAnchor() || candidate.hasProperty(ImageSourceProperty) ||
        candidate.boolProperty(ListMarkerProperty) || probe.selectedText().contains(QChar::ParagraphSeparator)) {
      selectedLink = false;
      break;
    }
    if (firstSelected) { selectedFormat = candidate; firstSelected = false; }
    else {
      if (candidate.anchorHref() != selectedFormat.anchorHref() ||
          candidate.property(LinkTitleProperty) != selectedFormat.property(LinkTitleProperty) ||
          candidate.property(LinkReferenceProperty) != selectedFormat.property(LinkReferenceProperty)) {
        selectedLink = false;
        break;
      }
      const auto properties = selectedFormat.properties();
      for (auto it = properties.cbegin(); it != properties.cend(); ++it)
        if (candidate.property(it.key()) != it.value()) selectedFormat.clearProperty(it.key());
    }
  }
  if (cursor_.hasSelection()) deleteBackward();
  QTextCharFormat format = selectedLink ? selectedFormat : cursor_.charFormat();
  if (replacedSelection && !selectedLink && format.isAnchor()) {
    format.setAnchor(false);
    format.clearProperty(QTextFormat::AnchorHref);
    format.clearProperty(LinkTitleProperty);
    format.clearProperty(LinkReferenceProperty);
    format.setFontUnderline(false);
    format.setForeground(cursor_.blockFormat().intProperty(QuoteDepthProperty) > 0 ? theme::muted() : theme::text());
  }
  if (format.boolProperty(ListMarkerProperty) || format.hasProperty(ImageSourceProperty)) format = bodyFormat();
  QString normalized = text;
  normalized.replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
  normalized.replace(QLatin1Char('\r'), QLatin1Char('\n'));
  if (cursor_.blockFormat().intProperty(RoleProperty) == RoleCode || cursor_.blockFormat().intProperty(RoleProperty) == RoleTable)
    normalized.replace(QLatin1Char('\n'), QChar::LineSeparator);
  cursor_.insertText(normalized, format);
  normalizeBlockImage(cursor_);
  cursor_.endEditBlock();
  typingContinuation_ = true; lastTypingPosition_ = cursor_.position();
  resetCaretBlink(); ensureCaretVisible(); viewport()->update();
}

void DocumentView::deleteBackward() {
  QTextCursor affected = cursor_;
  if (!affected.hasSelection() && affected.position() == affected.block().position())
    affected.movePosition(QTextCursor::PreviousCharacter, QTextCursor::KeepAnchor);
  if (replacesBlockStructure(affected) && protectNestedStructure(affected)) return;
  const QTextBlock block = cursor_.block();
  cursor_.beginEditBlock();
  if (cursor_.hasSelection()) {
    const QTextBlock firstContent = document_->begin().next();
    const bool entire = firstContent.isValid() && cursor_.selectionStart() <= firstContent.position() &&
                        cursor_.selectionEnd() >= document_->characterCount() - 1;
    const int firstSegment = firstContent.isValid() ? segmentOf(firstContent) : -1;
    cursor_.removeSelectedText();
    if (entire && firstSegment >= 0) {
      QTextBlockFormat format = bodyBlock();
      format.setProperty(SegmentProperty, firstSegment);
      format.setProperty(NodeProperty, -1000);
      format.setProperty(FlattenProperty, true);
      cursor_.setBlockFormat(format); cursor_.setCharFormat(bodyFormat());
    }
  } else if (blockEditable(block) && cursor_.position() > block.position()) {
    QTextCursor previous = cursor_;
    previous.movePosition(QTextCursor::PreviousCharacter, QTextCursor::KeepAnchor);
    if (previous.charFormat().boolProperty(ListMarkerProperty)) {
      changeListLevel(-1, block.blockFormat().intProperty(ListDepthProperty) == 0);
      cursor_.endEditBlock(); return;
    }
    cursor_.deletePreviousChar();
  } else if (blockEditable(block) && block.previous().isValid() && blockEditable(block.previous())) {
    cursor_.deletePreviousChar();
  }
  normalizeBlockImage(cursor_);
  cursor_.endEditBlock();
  resetCaretBlink(); ensureCaretVisible(); viewport()->update();
}

void DocumentView::deleteForward() {
  QTextCursor affected = cursor_;
  if (!affected.hasSelection() && affected.position() == affected.block().position() + affected.block().length() - 1)
    affected.movePosition(QTextCursor::NextCharacter, QTextCursor::KeepAnchor);
  if (replacesBlockStructure(affected) && protectNestedStructure(affected)) return;
  if (cursor_.hasSelection()) { deleteBackward(); return; }
  const QTextBlock block = cursor_.block();
  if (!blockEditable(block)) return;
  if (cursor_.position() == block.position() + block.length() - 1 &&
      (!block.next().isValid() || !blockEditable(block.next()))) return;
  QTextCursor next = cursor_; next.movePosition(QTextCursor::NextCharacter, QTextCursor::KeepAnchor);
  if (next.charFormat().boolProperty(ListMarkerProperty)) {
    moveCursor(QTextCursor::NextCharacter, QTextCursor::MoveAnchor); return;
  }
  cursor_.beginEditBlock();
  cursor_.deleteChar();
  normalizeBlockImage(cursor_);
  cursor_.endEditBlock();
  resetCaretBlink(); ensureCaretVisible(); viewport()->update();
}

void DocumentView::splitBlockAtCursor() {
  if (replacesBlockStructure(cursor_) && protectNestedStructure(cursor_)) return;
  if (cursor_.blockFormat().intProperty(RoleProperty) != RoleCode &&
      cursor_.blockFormat().intProperty(RoleProperty) != RoleTable && protectNestedStructure(cursor_)) return;
  if (!blockEditable(cursor_.block()) && !cursor_.hasSelection()) return;
  cursor_.beginEditBlock();
  if (cursor_.hasSelection()) deleteBackward();
  normalizeBlockImage(cursor_, true);
  const QTextBlock block = cursor_.block();
  const int segment = segmentOf(block);
  if (block.blockFormat().intProperty(RoleProperty) == RoleCode ||
      block.blockFormat().intProperty(RoleProperty) == RoleTable) {
    cursor_.insertText(QString(QChar::LineSeparator));
    cursor_.endEditBlock(); resetCaretBlink(); ensureCaretVisible(); return;
  }
  if (block.text().isEmpty() && block.blockFormat().intProperty(QuoteDepthProperty)>0) {
    auto lifted=block.blockFormat();
    lifted.setProperty(QuoteDepthProperty,lifted.intProperty(QuoteDepthProperty)-1);
    lifted.setLeftMargin(qMax<qreal>(0,lifted.leftMargin()-18));lifted.setProperty(StructureChangedProperty,true);
    cursor_.setBlockFormat(lifted);cursor_.setCharFormat(lifted.intProperty(QuoteDepthProperty)>0?mutedFormat():bodyFormat());
    cursor_.endEditBlock();resetCaretBlink();ensureCaretVisible();return;
  }
  const bool splitHeading = block.blockFormat().intProperty(RoleProperty)==RoleHeading && cursor_.position()<block.position()+block.length()-1;
  QTextBlockFormat format = splitHeading ? block.blockFormat() : bodyBlock();
  format.setProperty(NodeProperty, block.blockFormat().intProperty(NodeProperty));
  format.setProperty(FlattenProperty, block.blockFormat().boolProperty(FlattenProperty));
  format.setProperty(QuoteDepthProperty, block.blockFormat().intProperty(QuoteDepthProperty));
  format.setProperty(QuoteListInsetsProperty, block.blockFormat().property(QuoteListInsetsProperty));
  format.setLeftMargin(block.blockFormat().leftMargin());
  format.setProperty(SegmentProperty, segment);
  const bool list = block.blockFormat().intProperty(RoleProperty) == RoleListItem;
  if (list && inlineMarkdown(block).isEmpty()) {
    changeListLevel(-1, block.blockFormat().intProperty(ListDepthProperty) == 0);
    cursor_.endEditBlock(); resetCaretBlink(); ensureCaretVisible(); return;
  }
  if (list) {
    format = block.blockFormat();
    format.setProperty(NewListItemProperty, true);
    format.setProperty(StructureChangedProperty, true);
    format.setProperty(ListNumberProperty, format.intProperty(ListNumberProperty) + 1);
    format.setTopMargin(4);
    if (format.hasProperty(TaskCheckedProperty)) format.setProperty(TaskCheckedProperty, false);
  }
  QTextCharFormat continuation=cursor_.charFormat();
  continuation.clearProperty(ListMarkerProperty);
  if(!splitHeading) {
    QFont font=continuation.boolProperty(InlineCodeProperty)?theme::monoFont(kCode):theme::uiFont(kBody);
    font.setWeight(continuation.boolProperty(MarkBoldProperty)?QFont::DemiBold:QFont::Normal);
    font.setItalic(continuation.boolProperty(MarkItalicProperty));font.setStrikeOut(continuation.boolProperty(MarkStrikeProperty));
    continuation.setFont(font);
    continuation.setForeground(!continuation.anchorHref().isEmpty()?theme::accent():format.intProperty(QuoteDepthProperty)>0?theme::muted():theme::text());
  }
  cursor_.insertBlock(format, continuation);
  if (list) {
    const QString marker = format.hasProperty(TaskCheckedProperty) ? QStringLiteral("\u2610  ") :
        format.boolProperty(ListOrderedProperty) ? QStringLiteral("%1. ").arg(format.intProperty(ListNumberProperty)) : QStringLiteral("\u2022  ");
    QTextCharFormat markerFormat = bodyFormat(); markerFormat.setProperty(ListMarkerProperty, true);
    cursor_.insertText(marker, markerFormat); cursor_.setCharFormat(continuation);
  }
  cursor_.endEditBlock();
  resetCaretBlink(); ensureCaretVisible(); viewport()->update();
}

void DocumentView::clearPreeditLayout() {
  if (preeditBlock_.isValid() && preeditBlock_.layout()) {
    preeditBlock_.layout()->setPreeditArea(-1, QString());
    preeditBlock_.layout()->setFormats(preeditBaseFormats_);
    document_->markContentsDirty(preeditBlock_.position(), preeditBlock_.length());
  }
  preeditBlock_ = QTextBlock(); preeditBaseFormats_.clear();
  preeditPosition_ = preeditCursor_ = 0;
  preeditCursorVisible_ = true; preeditCursorColor_ = QColor();
}

void DocumentView::inputMethodEvent(QInputMethodEvent* event) {
  if (empty_ || readOnly_ || (!blockEditable(cursor_.block()) && !cursor_.hasSelection())) { event->ignore(); return; }
  if (!event->commitString().isEmpty() || event->replacementLength() > 0) {
    if (replacesBlockStructure(cursor_, event->commitString()) && protectNestedStructure(cursor_)) { event->ignore(); return; }
    if (event->replacementStart() != 0 || event->replacementLength() != 0) {
      QTextCursor affected = cursor_;
      const int start = qBound(0, cursor_.selectionStart() + event->replacementStart(), document_->characterCount() - 1);
      const int end = qBound(start, start + event->replacementLength() + (cursor_.hasSelection() ? cursor_.selectionEnd() - cursor_.selectionStart() : 0), document_->characterCount() - 1);
      affected.setPosition(start); affected.setPosition(end, QTextCursor::KeepAnchor);
      if (replacesBlockStructure(affected, event->commitString()) && protectNestedStructure(affected)) { event->ignore(); return; }
    }
  }
  const bool wasComposing = isComposing();
  clearPreeditLayout();
  preedit_ = event->preeditString();
  if (!event->commitString().isEmpty() || event->replacementLength() > 0) {
    cursor_.beginEditBlock();
    // Keep a selected range intact while composing; replace it once on commit.
    // This also makes cancelling a composition non-destructive.
    if (event->replacementStart() != 0 || event->replacementLength() != 0) {
      if (cursor_.hasSelection()) deleteBackward();
      const int start = qBound(0, cursor_.position() + event->replacementStart(), document_->characterCount() - 1);
      cursor_.setPosition(start);
      cursor_.setPosition(qBound(start, start + event->replacementLength(), document_->characterCount() - 1), QTextCursor::KeepAnchor);
    }
    if (event->commitString().isEmpty()) cursor_.removeSelectedText(); else insertTyped(event->commitString());
    cursor_.endEditBlock();
  }
  for (const auto& attribute : event->attributes()) if (attribute.type == QInputMethodEvent::Selection) {
    const int base = cursor_.block().position();
    const int end = document_->characterCount() - 1;
    cursor_.setPosition(qBound(0, base + attribute.start, end));
    cursor_.setPosition(qBound(0, base + attribute.start + attribute.length, end), QTextCursor::KeepAnchor);
  }
  if (!preedit_.isEmpty()) {
    const int start = cursor_.hasSelection() ? cursor_.selectionStart() : cursor_.position();
    preeditBlock_ = document_->findBlock(start);
    preeditPosition_ = start - preeditBlock_.position();
    preeditCursor_ = preedit_.size();
    auto* layout = preeditBlock_.layout();
    preeditBaseFormats_ = layout->formats();
    auto formats = preeditBaseFormats_;
    for (auto& format : formats) {
      if (format.start >= preeditPosition_) format.start += preedit_.size();
      else if (format.start + format.length > preeditPosition_) format.length += preedit_.size();
    }
    QTextLayout::FormatRange fallback;
    fallback.start = preeditPosition_; fallback.length = preedit_.size();
    fallback.format.setUnderlineStyle(QTextCharFormat::SingleUnderline);
    formats.append(fallback);
    for (const auto& attribute : event->attributes()) {
      if (attribute.type == QInputMethodEvent::Cursor) {
        preeditCursor_ = qBound(0, attribute.start, int(preedit_.size()));
        preeditCursorVisible_ = attribute.length != 0;
        if (attribute.value.canConvert<QColor>()) preeditCursorColor_ = attribute.value.value<QColor>();
      } else if (attribute.type == QInputMethodEvent::TextFormat) {
        QTextLayout::FormatRange range;
        range.start = preeditPosition_ + qBound(0, attribute.start, int(preedit_.size()));
        range.length = qMin(attribute.length, int(preedit_.size()) - (range.start - preeditPosition_));
        range.format = qvariant_cast<QTextFormat>(attribute.value).toCharFormat();
        if (range.length > 0) formats.append(range);
      }
    }
    layout->setPreeditArea(preeditPosition_, preedit_);
    layout->setFormats(formats);
    document_->markContentsDirty(preeditBlock_.position(), preeditBlock_.length());
  }
  relayout(); ensureCaretVisible();
  if (wasComposing && preedit_.isEmpty()) emit contentEdited();
  resetCaretBlink(); viewport()->update(); event->accept();
  if (auto* method = QGuiApplication::inputMethod()) method->update(Qt::ImQueryAll);
}

QVariant DocumentView::inputMethodQuery(Qt::InputMethodQuery query) const {
  switch (query) {
    case Qt::ImEnabled: return !empty_ && !readOnly_;
    case Qt::ImCursorRectangle:
    case Qt::ImAnchorRectangle: {
      QRectF caret = caretRectangle();
      if (query == Qt::ImAnchorRectangle && cursor_.hasSelection() && !isComposing()) {
        const QTextBlock block = document_->findBlock(cursor_.anchor());
        const int position = qBound(0, cursor_.anchor() - block.position(), qMax(0, block.length() - 1));
        const QTextLine line = block.layout()->lineForTextPosition(position);
        if (line.isValid()) {
          const QRectF bounds = document_->documentLayout()->blockBoundingRect(block);
          qreal x = bounds.left() + line.cursorToX(position);
          for (const auto& region : horizontalRegions_)
            if (region.node == block.blockFormat().intProperty(NodeProperty)) { x -= region.scroll; break; }
          caret = QRectF(x, bounds.top() + line.y(), 1, line.height());
        }
      }
      return QRect(qRound(caret.left() + contentLeft() + viewport()->x()),
                   qRound(caret.top() + topPadding() - verticalScrollBar()->value() + viewport()->y()), 1,
                   qMax(1, qRound(caret.height())));
    }
    case Qt::ImSurroundingText: return cursor_.block().text();
    case Qt::ImCursorPosition: return cursor_.position() - cursor_.block().position();
    case Qt::ImAnchorPosition: return cursor_.anchor() - cursor_.block().position();
    case Qt::ImAbsolutePosition: return cursor_.position();
    case Qt::ImCurrentSelection: return cursor_.selectedText();
    case Qt::ImFont: return cursor_.charFormat().font();
    case Qt::ImTextBeforeCursor: return cursor_.block().text().left(cursor_.positionInBlock());
    case Qt::ImTextAfterCursor: return cursor_.block().text().mid(cursor_.positionInBlock());
    case Qt::ImHints: return static_cast<int>(Qt::ImhNone);
    default: return QVariant();
  }
}

void DocumentView::hideEvent(QHideEvent* event) {
  stopHeadingScroll();
  QAbstractScrollArea::hideEvent(event);
  imageCache_.clear(); animationCache_.clear();
  for(auto& surface:rawSurfaces_) {surface.preview->imageCache_.clear();surface.preview->animationCache_.clear();}
}

void DocumentView::focusInEvent(QFocusEvent* event) {
  QAbstractScrollArea::focusInEvent(event);
  imageCache_.clear(); animationCache_.clear();
  bool resized=false;
  for(const auto& key:paintedImages_) {
    const auto data=bridge::readImage(documentPath_,imageSources_.value(key));
    const QByteArray url=data.value("dataUrl").toString().toLatin1();
    QBuffer buffer;buffer.setData(imageDecode::inputBytes(QByteArray::fromBase64(url.mid(url.indexOf(',')+1))));buffer.open(QIODevice::ReadOnly);
    QImageReader reader(&buffer);const QSize size=data.value("ok").toBool()?reader.size():QSize();
    if(size.isValid() && size!=imageSizes_.value(key)) {imageSizes_[key]=size;resized=true;}
    else if (!size.isValid() && key.startsWith(QStringLiteral("missing-image:")) && imageSizes_.remove(key)) resized=true;
  }
  if(resized){document_->markContentsDirty(0,document_->characterCount());relayout();}
  for (auto& surface : rawSurfaces_) { surface.preview->imageCache_.clear(); surface.preview->animationCache_.clear(); surface.preview->viewport()->update(); }
  resetCaretBlink();
}

void DocumentView::focusOutEvent(QFocusEvent* event) {
  if (isComposing() && event->reason() != Qt::PopupFocusReason) {
    // Give the platform a chance to commit a chosen candidate. A platform that
    // supplies no final event must not leave a phantom composition blocking save.
    if (auto* method = QGuiApplication::inputMethod()) method->commit();
    if (isComposing()) {
      clearPreeditLayout(); preedit_.clear(); relayout(); emit contentEdited();
    }
  }
  QAbstractScrollArea::focusOutEvent(event);
  if (caretTimer_ != nullptr) caretTimer_->stop();
  viewport()->update();
}

void DocumentView::wheelEvent(QWheelEvent* event) {
  stopHeadingScroll();
  const QPoint angle = event->angleDelta();
  const QPoint pixel = event->pixelDelta();
  if (angle.x() != 0 || pixel.x() != 0 || (event->modifiers() & Qt::ShiftModifier)) {
    const QPointF point = toDocument(event->position().toPoint());
    for (const auto& region : horizontalRegions_) {
      if (region.maximum <= 0 || !region.rect.adjusted(0, -16, 0, 16).contains(point)) continue;
      const qreal delta = !pixel.isNull() ? -(pixel.x() != 0 ? pixel.x() : pixel.y()) : -(angle.x() != 0 ? angle.x() : angle.y()) / 120.0 * 64;
      horizontalOffsets_[region.node] = qBound<qreal>(0, region.scroll + delta, region.maximum);
      rebuildDecorations(); viewport()->update(); event->accept(); return;
    }
  }
  if (!paintedTables_.isEmpty()) {
    const QPointF position = toDocument(event->position().toPoint());
    const QPoint angle = event->angleDelta();
    const bool horizontal = angle.x() != 0 || (event->modifiers() & Qt::ShiftModifier);
    if (horizontal) {
      for (PaintedTable& table : paintedTables_) {
        if (table.maxScroll <= 0) continue;
        const QRectF area(0, table.rect.top(), table.columnWidth, table.rect.height());
        if (!area.contains(position)) continue;
        const qreal delta = (angle.x() != 0 ? -angle.x() : -angle.y()) / 120.0 * 64.0;
        table.scroll = qBound<qreal>(0, table.scroll + delta, table.maxScroll);
        const qreal range = table.scrollTrack.width() - table.scrollThumb.width();
        if (range > 0) {
          table.scrollThumb.moveLeft(table.scrollTrack.left() + table.scroll / table.maxScroll * range);
        }
        viewport()->update();
        event->accept();
        return;
      }
    }
  }
  QAbstractScrollArea::wheelEvent(event);
}

void DocumentView::leaveEvent(QEvent* event) {
  viewport()->update();
  viewport()->setCursor(Qt::ArrowCursor);
  QAbstractScrollArea::leaveEvent(event);
}

void DocumentView::clearSearchHighlight() {
  matches_.clear();
  matchCount_ = 0;
  activeMatch_ = -1;
  viewport()->update();
}

void DocumentView::setSearchQuery(const QString& query, bool active) {
  const QString next = active ? query.trimmed() : QString();
  if (next == query_) { applySearchHighlight(query_); return; }
  query_ = next;
  clearSearchHighlight();
  applySearchHighlight(query_);
  if (!matches_.isEmpty()) focusSearchResult(0);
}

void DocumentView::applySearchHighlight(const QString& query) {
  const int previous = activeMatch_;
  matches_.clear();
  if (!query.isEmpty() && document_ != nullptr) {
    QTextCursor found(document_);
    while (!(found = document_->find(query, found)).isNull()) {
      if (segmentOf(found.block()) < 0) continue;
      // List bullets/numbers are layout decorations, not ProseMirror text.
      // Reject even a partial overlap so a query spanning marker + item cannot
      // promote a generated marker into authored Markdown during replacement.
      bool marker = false;
      for (auto fragment = found.block().begin(); !fragment.atEnd(); ++fragment) {
        const auto run = fragment.fragment();
        if (run.position() >= found.selectionEnd()) break;
        if (run.position() + run.length() > found.selectionStart() &&
            run.charFormat().boolProperty(ListMarkerProperty)) { marker = true; break; }
      }
      if (!marker) matches_.append(found);
    }
  }
  matchCount_ = matches_.size();
  activeMatch_ = matches_.isEmpty() || previous < 0 ? -1 : qMin(previous, matchCount_ - 1);
  viewport()->update();
}

void DocumentView::focusSearchResult(int index) {
  stopHeadingScroll();
  if (matches_.isEmpty()) return;
  activeMatch_ = ((index % matches_.size()) + matches_.size()) % matches_.size();
  cursor_ = matches_.at(activeMatch_);
  searchSelection_ = true;
  const int node = cursor_.blockFormat().intProperty(NodeProperty);
  if (rawSurfaces_.contains(node)) {
    const QTextCursor found = cursor_;
    // Revealing a search hit must not take keyboard focus from the query field.
    setRawSourceVisible(node, true, false); cursor_ = found;
  }
  ensureCaretVisible();
  viewport()->update();
}

void DocumentView::stopHeadingScroll() {
  if (headingScroll_) headingScroll_->stop();
}

void DocumentView::scrollToHeadingPosition(int position) {
  stopHeadingScroll();
  auto* scroll = verticalScrollBar();
  const int target = qBound(0, position, scroll->maximum());
  bool motion = true;
#ifdef Q_OS_WIN
  BOOL enabled = TRUE;
  if (SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0)) motion = enabled;
#endif
  // Respect Windows' reduced-motion preference, as the original respects
  // prefers-reduced-motion. Preview children do not own the outer scroll.
  if (!motion || previewMode_ || target == scroll->value()) { scroll->setValue(target); return; }
  if (!headingScroll_) {
    headingScroll_ = new QPropertyAnimation(scroll, "value", this);
    headingScroll_->setObjectName("headingScrollAnimation");
    headingScroll_->setEasingCurve(QEasingCurve::InOutCubic);
    connect(scroll, &QScrollBar::sliderPressed, this, &DocumentView::stopHeadingScroll);
    connect(scroll, &QScrollBar::actionTriggered, this, [this](int) { stopHeadingScroll(); });
  }
  headingScroll_->setDuration(qBound(180, qAbs(target - scroll->value()) / 4, 450));
  headingScroll_->setStartValue(scroll->value());
  headingScroll_->setEndValue(target);
  headingScroll_->start();
}

void DocumentView::setScrollValue(int value) { stopHeadingScroll(); verticalScrollBar()->setValue(value); }

int DocumentView::scrollValue() const { return verticalScrollBar()->value(); }

bool DocumentView::revealText(const QString& text) {
  stopHeadingScroll();
  if (document_ == nullptr || text.isEmpty()) return false;
  QTextCursor found = document_->find(text);
  if (found.isNull()) return false;
  cursor_ = found;
  const int node = cursor_.blockFormat().intProperty(NodeProperty);
  if (rawSurfaces_.contains(node)) { setRawSourceVisible(node, true); cursor_ = found; }
  const QRectF rect = document_->documentLayout()->blockBoundingRect(found.block());
  const int target = qRound(rect.top() + topPadding()) - 80;
  verticalScrollBar()->setValue(qBound(0, target, verticalScrollBar()->maximum()));
  viewport()->update();
  return true;
}

bool DocumentView::revealHeading(int index) {
  int current = 0;
  for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
    const auto format = block.blockFormat();
    if (format.intProperty(RoleProperty) != RoleHeading && !format.boolProperty(RawProperty)) continue;
    const QRectF rect = blockRectCache_.contains(block.blockNumber())
      ? blockRectCache_.value(block.blockNumber()) : document_->documentLayout()->blockBoundingRect(block);
    const int node = format.intProperty(NodeProperty);
    if (format.boolProperty(RawProperty) && rawSurfaces_.contains(node)) {
      auto& surface = rawSurfaces_[node];
      int count = 0;
      for (QTextBlock child = surface.preview->document_->begin(); child.isValid(); child = child.next())
        if (child.blockFormat().intProperty(RoleProperty) == RoleHeading) ++count;
      if (index >= current && index < current + count) {
        setRawSourceVisible(node, false);
        scrollToHeadingPosition(qRound(rect.top() + topPadding()) - 24);
        surface.preview->revealHeading(index - current); return true;
      }
      current += count;
    }
    if (block.blockFormat().intProperty(RoleProperty) != RoleHeading) continue;
    if (current++ != index) continue;
    cursor_ = QTextCursor(block);
    // Match .document-editor heading scroll-margin-block-start:24px.
    scrollToHeadingPosition(qRound(rect.top() + topPadding()) - 24);
    viewport()->update(); return true;
  }
  return false;
}

int DocumentView::currentHeadingIndex() const {
  int current = -1, active = -1;
  const int top = verticalScrollBar()->value();
  for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
    const auto format = block.blockFormat();
    if (format.intProperty(RoleProperty) != RoleHeading && !format.boolProperty(RawProperty)) continue;
    const QRectF rect = blockRectCache_.contains(block.blockNumber())
      ? blockRectCache_.value(block.blockNumber()) : document_->documentLayout()->blockBoundingRect(block);
    const int node = format.intProperty(NodeProperty);
    if (format.boolProperty(RawProperty) && rawSurfaces_.contains(node)) {
      const auto& surface = rawSurfaces_[node];
      int count = 0;
      for (QTextBlock child = surface.preview->document_->begin(); child.isValid(); child = child.next())
        if (child.blockFormat().intProperty(RoleProperty) == RoleHeading) ++count;
      if (count && rect.top() + topPadding() <= top + 100) active = current + 1 + qMax(0, surface.preview->currentHeadingIndex());
      current += count;
    }
    if (block.blockFormat().intProperty(RoleProperty) != RoleHeading) continue;
    ++current;
    if (rect.top() + topPadding() <= top + 100) active = current;
  }
  return active < 0 && current >= 0 ? 0 : active;
}

QPointF DocumentView::hitDocumentPoint(const QPoint& viewportPosition) const {
  QPointF point = toDocument(viewportPosition);
  for (const auto& region : horizontalRegions_) {
    if (region.rect.contains(point)) { point.rx() += region.scroll; break; }
  }
  return point;
}

void DocumentView::layoutRawSurfaces() {
  QHash<int,QRectF> bounds;
  if(rawSurfaces_.isEmpty())return;
  for(QTextBlock block=document_->begin();block.isValid();block=block.next()) {
    const auto format=block.blockFormat();
    const bool preview=format.hasProperty(RawPreviewOwnerProperty);
    if(!preview && !format.boolProperty(RawProperty))continue;
    const int node=preview?format.intProperty(RawPreviewOwnerProperty):format.intProperty(NodeProperty);
    if(!rawSurfaces_.contains(node)||rawSurfaces_.value(node).source==preview)continue;
    bounds[node]=blockRectCache_.contains(block.blockNumber())?blockRectCache_.value(block.blockNumber()):document_->documentLayout()->blockBoundingRect(block);
  }
  for (auto& surface : rawSurfaces_) {
    const QRectF rect=bounds.value(surface.node);
    if (rect.isEmpty()) { surface.preview->hide(); continue; }
    const int y = qRound(rect.top() + topPadding() - (surface.source ? 16 : 0)) - scrollValue();
    surface.preview->setGeometry(contentLeft(), y, contentWidth(), qMax(32, qRound(rect.height())));
    const bool visible=y<viewport()->height() && y+rect.height()>0;
    surface.preview->setVisible(!surface.source && visible);

  }
}

void DocumentView::setRawSourceVisible(int node, bool source, bool focusEditor) {
  if (!rawSurfaces_.contains(node)) return;
  auto& surface = rawSurfaces_[node];
  if (surface.source == source) return;
  surface.source = source;
  if (source) { surface.preview->imageCache_.clear(); surface.preview->animationCache_.clear(); }
  if (!source) {
    for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
      if (!block.blockFormat().hasProperty(NodeProperty) || block.blockFormat().intProperty(NodeProperty) != node) continue;
      QString markdown = block.text(); markdown.replace(QChar::LineSeparator, QLatin1Char('\n'));
      QJsonObject plan;
      const QJsonArray context = bridge::planFor(previewContext_).value("plan").toObject().value("blocks").toArray();
      for (const auto& value : context) {
        const auto candidate = value.toObject();
        if (candidate.value("type").toString() == "raw" && candidate.value("text").toString().trimmed() == markdown.trimmed()) {
          plan = candidate.value("preview").toObject(); break;
        }
      }
      if (plan.isEmpty()) plan = bridge::planFor(markdown).value("plan").toObject();
      const QJsonArray blocks = plan.value("blocks").toArray();
      if (blocks.size() == 1 && blocks.first().toObject().value("type").toString() == "raw")
        plan = blocks.first().toObject().value("preview").toObject();
        surface.plan = withTaskListSpacing(plan, markdown);
        surface.preview->setPlan(surface.plan, documentPath_); break;
    }
  } else {
    for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
      if (block.blockFormat().hasProperty(NodeProperty) && block.blockFormat().intProperty(NodeProperty) == node) {
        cursor_ = QTextCursor(block); break;
      }
    }
    if (focusEditor) setFocus(Qt::OtherFocusReason);
  }
  for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
    const auto format = block.blockFormat();
    const bool original = format.hasProperty(NodeProperty) && format.intProperty(NodeProperty) == node && format.boolProperty(RawProperty);
    const bool preview = format.hasProperty(RawPreviewOwnerProperty) && format.intProperty(RawPreviewOwnerProperty) == node;
    if (original || preview) { block.setVisible(original ? source : !source); if (!block.isVisible()) block.setLineCount(0); }
  }
  document_->markContentsDirty(0, document_->characterCount());
  relayout(); viewport()->update();
}

int DocumentView::replacementChangeCount(const QString& replacement) const {
  int count = 0;
  for (const auto& range : matches_) if (range.selectedText() != replacement) ++count;
  return count;
}

QImage DocumentView::decodedImage(const QString& path) {
  const QString key = normalizedImagePath(path);
  if (!authorizedImages_.contains(key)) return {};
  paintedImages_.insert(key);
  if (const auto* animation = animationCache_.object(key)) return animation->movie.currentImage();
  if (const auto* cached = imageCache_.object(key)) return *cached;
  const auto result = bridge::readImage(documentPath_,imageSources_.value(key));
  if (!result.value("ok").toBool()) { imageCache_.insert(key,new QImage,1); return {}; }
  const QByteArray url = result.value("dataUrl").toString().toLatin1();
  const QByteArray bytes = imageDecode::inputBytes(QByteArray::fromBase64(url.mid(url.indexOf(',')+1)));
  QBuffer buffer; buffer.setData(bytes); buffer.open(QIODevice::ReadOnly);
  QImageReader reader(&buffer);
  const QSize natural = reader.size();
  if (!natural.isValid() || qint64(natural.width()) * natural.height() > 100000000) return {};
  const QSize scaled = natural.scaled(qMin(natural.width(),qRound(qMax(160, contentWidth()) * devicePixelRatioF())),
                                     8192, Qt::KeepAspectRatio);
  if (scaled.width() < natural.width() || scaled.height() < natural.height()) reader.setScaledSize(scaled);
  if (reader.supportsAnimation()) {
    auto* animation = new AnimatedImage(bytes);
    animation->movie.setCacheMode(QMovie::CacheNone);
    animation->movie.setScaledSize(scaled);
    const int cost=qMax(1,int((bytes.size()+qint64(scaled.width())*scaled.height()*4)/1024));
    if (cost <= animationCache_.maxCost()) {
      connect(&animation->movie,&QMovie::frameChanged,this,[this](int){ viewport()->update(); });
      animation->movie.start();
      const QImage frame=animation->movie.currentImage();
      if (!frame.isNull()) { animationCache_.insert(key,animation,cost); return frame; }
    }
    delete animation;
  }
  QImage image = reader.read();
  if (image.isNull()) return {};
  imageCache_.insert(key, new QImage(image), qMax(1, int(image.sizeInBytes() / 1024)));
  return image;
}

QSizeF RawPreviewObject::intrinsicSize(QTextDocument*, int, const QTextFormat& format) {
  return measure ? measure(format) : QSizeF();
}

void DocumentView::changeListLevel(int delta, bool exitList) {
  if (protectNestedStructure(cursor_)) return;
  QTextBlock block = cursor_.block();
  auto format = block.blockFormat();
  if (format.intProperty(RoleProperty) != RoleListItem) return;
  const int oldDepth = format.intProperty(ListDepthProperty);
  if (delta > 0) {
    const auto previous = block.previous();
    if (!previous.isValid() || segmentOf(previous) != segmentOf(block) ||
        !previous.blockFormat().hasProperty(ListDepthProperty)) return;
  }
  const int depth = qMax(0, oldDepth + delta);
  exitList = exitList || (delta < 0 && oldDepth == 0);
  cursor_.beginEditBlock();
  if (exitList) {
    QTextCursor marker(block);
    for (auto it = block.begin(); !it.atEnd(); ++it) {
      const auto fragment = it.fragment();
      if (!fragment.charFormat().boolProperty(ListMarkerProperty)) break;
      marker.setPosition(fragment.position()); marker.setPosition(fragment.position()+fragment.length(), QTextCursor::KeepAnchor);
      marker.removeSelectedText(); break;
    }
    format.setProperty(RoleProperty, RoleBody);
    format.clearProperty(ListDepthProperty); format.clearProperty(ListNumberProperty); format.clearProperty(ListOrderedProperty);
    format.clearProperty(NewListItemProperty); format.setTextIndent(0);
    format.clearProperty(TaskCheckedProperty); format.clearProperty(ListLooseProperty);
    format.setLeftMargin(format.intProperty(QuoteDepthProperty) * 18);
  } else {
    format.setProperty(ListDepthProperty, depth);
    format.setLeftMargin(24 * (depth + 1) + format.intProperty(QuoteDepthProperty) * 18);
  }
  format.setProperty(StructureChangedProperty, true);
  QTextCursor change(block); change.setBlockFormat(format);
  // Children of a nested item move with their parent until its next sibling.
  for (auto child = block.next(); child.isValid() && segmentOf(child) == segmentOf(block); child = child.next()) {
    auto childFormat = child.blockFormat();
    if (!childFormat.hasProperty(ListDepthProperty) || childFormat.intProperty(ListDepthProperty) <= oldDepth) break;
    const int childDepth = qMax(0, childFormat.intProperty(ListDepthProperty) + (exitList ? -1 : depth-oldDepth));
    childFormat.setProperty(ListDepthProperty, childDepth);
    childFormat.setLeftMargin(24*(childDepth+1)+childFormat.intProperty(QuoteDepthProperty)*18);
    QTextCursor childCursor(child); childCursor.setBlockFormat(childFormat);
  }
  cursor_.endEditBlock(); resetCaretBlink(); ensureCaretVisible(); viewport()->update();
}

QString DocumentView::serializeFlatSegment(int segment) const {
  QHash<int,QJsonObject> nodes;
  std::function<void(const QJsonArray&)> collect = [&](const QJsonArray& values) {
    for (const auto& value : values) { const auto node=value.toObject(); nodes.insert(node.value("nodeId").toInt(-1),node);
      collect(node.value("blocks").toArray()); for (const auto& item : node.value("items").toArray()) collect(item.toArray()); }
  };
  collect(modelTree_);
  QSet<int> tables;
  QString output;
  bool previousList = false;
  bool previousLoose = false;
  QHash<int,int> numbers;
  QHash<int,int> markerWidths;
  int previousDepth=-1;
  for (const QTextBlock& block : segmentBlocks_.value(segment)) {
    const auto format=block.blockFormat(); const int role=format.intProperty(RoleProperty);
    const int nodeId=format.intProperty(NodeProperty); const auto node=nodes.value(nodeId);
    const bool list=format.hasProperty(ListNumberProperty) || role==RoleListItem;
    QString text;
    if (node.value("type").toString()=="table") {
      if(tables.contains(nodeId)) continue; tables.insert(nodeId); text=serializeNode(node);
    } else if(role==RoleCode) {
      text=block.text(); text.replace(QChar::LineSeparator,QLatin1Char('\n'));
      if(!format.boolProperty(RawProperty)) text=fenced(text,format.stringProperty(CodeLanguageProperty));
    } else if(role==RoleRule) text=QStringLiteral("---");
    else {
      text=inlineMarkdown(block);
      if(role==RoleHeading) text=QString(qBound(1,format.intProperty(HeadingLevelProperty),6),'#')+QLatin1Char(' ')+text;
      else if (!(text.isEmpty() && format.hasProperty(ListDepthProperty))) text=paragraphMarkdown(text);
    }
    // Merge quote ancestors at the list level where each was entered. Putting
    // all quote markers outside the list changes `- > text` into `> - text`.
    const int depth = format.hasProperty(ListDepthProperty) ? format.intProperty(ListDepthProperty) : -1;
    QString marker;
    if (list) {
      if (depth <= previousDepth) {
        for (int key : numbers.keys()) if (key > depth) numbers.remove(key);
        for (int key : markerWidths.keys()) if (key > depth) markerWidths.remove(key);
      }
      marker = QStringLiteral("- ");
      if (format.boolProperty(ListOrderedProperty)) {
        const int number = numbers.contains(depth) ? numbers.value(depth) : format.intProperty(ListNumberProperty);
        numbers[depth] = number + 1;
        marker = QString::number(number) + (format.stringProperty(ListDelimiterProperty).isEmpty() ? QStringLiteral(".") : format.stringProperty(ListDelimiterProperty)) + QLatin1Char(' ');
      }
      markerWidths[depth] = marker.size();
      previousDepth = depth;
      if (format.hasProperty(TaskCheckedProperty))
        text.prepend(format.boolProperty(TaskCheckedProperty) ? QStringLiteral("[x] ") : QStringLiteral("[ ] "));
    }
    QString prefix, continuation;
    const int quotes = format.intProperty(QuoteDepthProperty);
    const QVariantList quoteInsets = format.property(QuoteListInsetsProperty).toList();
    int quoteIndex = 0;
    for (int level = 0; level <= depth + 1; ++level) {
      while (quoteIndex < quotes &&
             (quoteIndex >= quoteInsets.size() || quoteInsets.at(quoteIndex).toInt() / 24 <= level)) {
        prefix += QStringLiteral("> ");
        continuation += QStringLiteral("> ");
        ++quoteIndex;
      }
      if (level <= depth) {
        const QString indent(markerWidths.value(level, 2), QLatin1Char(' '));
        prefix += list && level == depth ? marker : indent;
        continuation += indent;
      }
    }
    // Missing/stale ancestry after lifting a list cannot discard quote syntax.
    while (quoteIndex++ < quotes) {
      prefix += QStringLiteral("> ");
      continuation += QStringLiteral("> ");
    }
    text.replace(QStringLiteral("\n"), QLatin1Char('\n') + continuation);
    text.prepend(prefix);
    const bool loose = format.boolProperty(ListLooseProperty);
    if(!output.isEmpty()) output+=list&&previousList&&!loose&&!previousLoose?QStringLiteral("\n"):QStringLiteral("\n\n");
    output+=text;previousList=list;
    previousLoose=loose;
  }
  return output;
}

void DocumentView::contextMenuEvent(QContextMenuEvent* event) {
  if (empty_) return;
  const int position = document_->documentLayout()->hitTest(hitDocumentPoint(event->pos()), Qt::FuzzyHit);
  if (position >= 0 && !cursor_.hasSelection()) cursor_.setPosition(position);
  QMenu menu(this);
  auto command = [&](const QString& label, int key, bool enabled) {
    QAction* action = menu.addAction(label); action->setEnabled(enabled);
    connect(action, &QAction::triggered, this, [this, key] {
      QKeyEvent press(QEvent::KeyPress, key, Qt::ControlModifier); keyPressEvent(&press);
    });
  };
  const bool editing = !readOnly_ && !isComposing();
  command(QStringLiteral("撤销"), Qt::Key_Z, editing && document_->isUndoAvailable());
  command(QStringLiteral("重做"), Qt::Key_Y, editing && document_->isRedoAvailable());
  menu.addSeparator();
  command(QStringLiteral("剪切"), Qt::Key_X, editing && cursor_.hasSelection());
  command(QStringLiteral("复制"), Qt::Key_C, cursor_.hasSelection());
  command(QStringLiteral("粘贴"), Qt::Key_V, editing && !QApplication::clipboard()->text().isEmpty());
  command(QStringLiteral("全选"), Qt::Key_A, true);
  QTextCursor probe = cursor_;
  if (probe.charFormat().anchorHref().isEmpty()) probe.movePosition(QTextCursor::NextCharacter, QTextCursor::KeepAnchor);
  const QString href = probe.charFormat().anchorHref();
  if (!href.isEmpty()) {
    menu.addSeparator();
    connect(menu.addAction(QStringLiteral("打开链接")), &QAction::triggered, this, [this, href] { emit linkActivated(href); });
  }
  menu.exec(event->globalPos());
}

void DocumentView::setPreviewContext(const QString& markdown) {
  if (previewContext_ == markdown) return;
  previewContext_ = markdown;
  if (rawSurfaces_.isEmpty()) return;
  const auto plan = bridge::planFor(markdown).value("plan").toObject();
  const auto blocks = plan.value("blocks").toArray();
  bool changed = false;
  for (auto& surface : rawSurfaces_) {
    if (surface.source) continue;
    QString source;
    for (QTextBlock block = document_->begin(); block.isValid(); block = block.next()) {
      if (block.blockFormat().hasProperty(NodeProperty) && block.blockFormat().intProperty(NodeProperty) == surface.node && block.blockFormat().boolProperty(RawProperty)) {
        source = block.text(); source.replace(QChar::LineSeparator, QLatin1Char('\n')); break;
      }
    }
    if (source.isEmpty()) continue;
    QJsonObject preview;
    for (const auto& value : blocks) {
      const auto node = value.toObject();
      if (node.value("type").toString() == "raw" && node.value("text").toString().trimmed() == source.trimmed()) {
        preview = node.value("preview").toObject(); break;
      }
    }
    if (preview.isEmpty()) continue;
    if (preview.value("blocks").toArray().isEmpty()) {
      QJsonObject run{{"kind","text"},{"text",QStringLiteral("此内容无法预览，请切换源码查看。")}};
      preview.insert("blocks",QJsonArray{QJsonObject{{"type","paragraph"},{"runs",QJsonArray{run}}}});
    }
    preview = withTaskListSpacing(preview, source);
    if (preview == surface.plan) continue;
    const int scroll = surface.preview->scrollValue();
    surface.plan = preview; surface.preview->setPlan(preview, documentPath_); surface.preview->setScrollValue(scroll);
    changed = true;
  }
  if (changed) {
    document_->markContentsDirty(0, document_->characterCount());
    relayout(); emit viewportChanged();
  }
}

namespace {
QMap<int,QPair<qreal,qreal>> segmentBounds(QTextDocument* document,const QJsonArray& model) {
  QHash<int,int> owners;
  std::function<void(const QJsonArray&,int)> collect=[&](const QJsonArray& nodes,int inherited) {
    for(const auto& value:nodes){const auto node=value.toObject();const int segment=node.value("segment").toInt(inherited);
      owners.insert(node.value("nodeId").toInt(-1),segment);collect(node.value("blocks").toArray(),segment);
      for(const auto& item:node.value("items").toArray())collect(item.toArray(),segment);}
  };collect(model,-1);
  QMap<int,QPair<qreal,qreal>> bounds;
  for(auto block=document->begin();block.isValid();block=block.next()) {
    if(!block.isVisible())continue;
    const auto format=block.blockFormat();
    const int segment=format.hasProperty(SegmentProperty)?format.intProperty(SegmentProperty):format.hasProperty(RawPreviewOwnerProperty)?owners.value(format.intProperty(RawPreviewOwnerProperty),-1):-1;
    if(segment<0)continue;
    const auto rect=document->documentLayout()->blockBoundingRect(block);
    if(!bounds.contains(segment))bounds.insert(segment,{rect.top(),rect.bottom()});
    else{bounds[segment].first=qMin(bounds[segment].first,rect.top());bounds[segment].second=qMax(bounds[segment].second,rect.bottom());}
  }return bounds;
}
QString normalizedAnchorSource(QString source) {
  return source.replace(QStringLiteral("\r\n"),QStringLiteral("\n")).replace(QLatin1Char('\r'),QLatin1Char('\n')).trimmed();
}
}

QJsonObject DocumentView::readingAnchor() const {
  const auto bounds=segmentBounds(document_,modelTree_);
  if(bounds.isEmpty())return {};
  const qreal top=scrollValue()-topPadding();
  int segment=bounds.lastKey();
  for(auto it=bounds.cbegin();it!=bounds.cend();++it)if(it.value().second>=top){segment=it.key();break;}
  QString original;
  for(const auto& value:modelTree_)if(value.toObject().value("segment").toInt(-1)==segment){original=value.toObject().value("source").toString();break;}
  const QString serialized=serializeSegment(segment);
  const QString source=serialized==baselineSegments_.value(segment)?original:serialized;
  const auto range=bounds.value(segment);
  return QJsonObject{{"source",source},{"ordinal",segment},{"fraction",qBound<qreal>(0,(top-range.first)/qMax<qreal>(1,range.second-range.first),1)},
    {"heading",currentHeadingIndex()},{"overallRatio",verticalScrollBar()->maximum()>0?double(scrollValue())/verticalScrollBar()->maximum():0}};
}

bool DocumentView::restoreReadingAnchor(const QJsonObject& anchor) {
  const QString source=normalizedAnchorSource(anchor.value("source").toString());
  if(source.isEmpty())return false;
  const int ordinal=anchor.value("ordinal").toInt(0);
  int match=-1,distance=std::numeric_limits<int>::max();
  for(const auto& value:modelTree_) {
    const auto node=value.toObject();const int segment=node.value("segment").toInt(-1);if(segment<0)continue;
    if(normalizedAnchorSource(node.value("source").toString())!=source && normalizedAnchorSource(serializeSegment(segment))!=source)continue;
    if(qAbs(segment-ordinal)<distance){match=segment;distance=qAbs(segment-ordinal);}
  }
  const auto bounds=segmentBounds(document_,modelTree_);
  if(match<0 || !bounds.contains(match))return false;
  const auto range=bounds.value(match);
  const qreal fraction=qBound<qreal>(0,anchor.value("fraction").toDouble(),1);
  setScrollValue(qRound(range.first+fraction*(range.second-range.first)+topPadding()));
  return true;
}

void DocumentView::restoreSelectionState(const QPair<int,int>& state) {
  searchSelection_ = false;
  const int maximum=qMax(0,document_->characterCount()-1);
  cursor_=QTextCursor(document_);cursor_.setPosition(qBound(0,state.first,maximum));
  cursor_.setPosition(qBound(0,state.second,maximum),QTextCursor::KeepAnchor);
  viewport()->update();
}

void DocumentView::refreshTableGeometry(const QTextBlock& block) {
  QTextCursor cursor(block);auto* table=cursor.currentTable();if(!table){relayout();return;}
  const QRectF oldCell=blockRectCache_.value(block.blockNumber());
  int index=-1;for(int i=0;i<tableBoxes_.size();++i)if(tableBoxes_[i].rect.contains(oldCell.center())){index=i;break;}
  if(index<0){relayout();return;}
  auto* layout=document_->documentLayout();const QRectF old=tableBoxes_[index].rect;
  QRectF rect=layout->frameBoundingRect(table);rect.moveLeft(rect.left()-10);
  const qreal delta=rect.height()-old.height();const int last=table->lastCursorPosition().blockNumber();
  auto shift=[&](QRectF& value){if(value.top()>=old.bottom()-.1)value.translate(0,delta);};
  if(qAbs(delta)>.01){
    cachedDocumentHeight_+=delta;
    for(auto it=blockRectCache_.begin();it!=blockRectCache_.end();++it)if(it.key()>last)it.value().translate(0,delta);
    for(auto& box:codeBoxes_)shift(box.rect);
    for(auto& box:quoteBars_){if(box.rect.top()<=old.top()&&box.rect.bottom()>=old.bottom())box.rect.setBottom(box.rect.bottom()+delta);else shift(box.rect);}
    for(auto& line:ruleLines_)if(line.from.y()>=old.bottom()){line.from.ry()+=delta;line.to.ry()+=delta;}
    for(auto& box:imageBoxes_)shift(box.rect);
    for(int i=0;i<tableBoxes_.size();++i)if(i!=index && tableBoxes_[i].rect.top()>=old.bottom()){auto& box=tableBoxes_[i];box.rect.translate(0,delta);for(auto& y:box.rows)y+=delta;for(auto& line:box.grid)line.translate(0,delta);}
    for(auto& region:horizontalRegions_){shift(region.rect);shift(region.track);shift(region.thumb);shift(region.copy);}
  }
  const int node=table->format().intProperty(NodeProperty);
  for(auto& region:horizontalRegions_)if(region.node==node){region.rect.setTop(rect.top());region.rect.setHeight(rect.height());region.track.moveTop(rect.bottom()+4);region.thumb.moveTop(region.track.top());}
  auto& box=tableBoxes_[index];box.rect=rect;box.rows.clear();box.grid.clear();
  for(int row=0;row<table->rows();++row){qreal top=rect.bottom();for(int col=0;col<table->columns();++col){const auto cell=table->cellAt(row,col);if(cell.row()==row)top=qMin(top,layout->blockBoundingRect(cell.firstCursorPosition().block()).top());}box.rows.append(top);}box.rows.append(rect.bottom());
  for(int row=0;row<table->rows();++row)for(int col=0;col<table->columns();++col){const auto cell=table->cellAt(row,col);if(cell.row()!=row||cell.column()!=col)continue;const int right=qMin(table->columns(),col+cell.columnSpan()),bottom=qMin(table->rows(),row+cell.rowSpan());if(right<table->columns())box.grid.append(QLineF(box.columns[right],box.rows[row],box.columns[right],box.rows[bottom]));if(bottom<table->rows())box.grid.append(QLineF(box.columns[col],box.rows[bottom],box.columns[right],box.rows[bottom]));}
  for(int i=inlineBoxes_.size()-1;i>=0;--i){if(old.contains(inlineBoxes_[i].rect.center()))inlineBoxes_.removeAt(i);else shift(inlineBoxes_[i].rect);}
  for(auto cellBlock=table->firstCursorPosition().block();cellBlock.isValid()&&cellBlock.blockNumber()<=last;cellBlock=cellBlock.next()){
    const QRectF cellRect=layout->blockBoundingRect(cellBlock);blockRectCache_[cellBlock.blockNumber()]=cellRect;auto* lines=cellBlock.layout();
    for(auto it=cellBlock.begin();!it.atEnd();++it){const auto fragment=it.fragment();const auto format=fragment.charFormat();if(!format.boolProperty(InlineCodeProperty))continue;const int from=fragment.position()-cellBlock.position(),to=from+fragment.length();for(int i=0;i<lines->lineCount();++i){const auto line=lines->lineAt(i);const int start=qMax(from,line.textStart()),end=qMin(to,line.textStart()+line.textLength());if(start>=end)continue;const qreal height=QFontMetricsF(format.font()).height()+kInlineCodePadY*2;inlineBoxes_.append({QRectF(cellRect.left()+line.cursorToX(start)-kInlineCodePadX,cellRect.top()+line.y()+(line.height()-height)/2,line.cursorToX(end)-line.cursorToX(start)+kInlineCodePadX*2,height)});}}
  }
  updateScrollRange();layoutRawSurfaces();viewport()->update();
}

void DocumentView::refreshBlockGeometry(const QTextBlock& block) {
  if(block.blockFormat().intProperty(RoleProperty)==RoleTable){refreshTableGeometry(block);return;}
  const QRectF old=blockRectCache_.value(block.blockNumber());
  const QRectF rect=document_->documentLayout()->blockBoundingRect(block);
  const qreal delta=rect.height()-old.height();
  const bool table=block.blockFormat().intProperty(RoleProperty)==RoleTable;
  // Stable cell geometry needs no whole-document reflow. A wrap/row-height
  // change still takes the structural path until the table frame is reconciled.
  if(table && (qAbs(delta)>0.01 || qAbs(rect.width()-old.width())>0.01)){relayout();return;}
  auto shift=[&](QRectF& value){if(value.top()>=old.bottom()-0.1)value.translate(0,delta);};
  if(qAbs(delta)>0.01) {
    cachedDocumentHeight_+=delta;
    for(auto it=blockRectCache_.begin();it!=blockRectCache_.end();++it)if(it.key()>block.blockNumber())it.value().translate(0,delta);
    for(auto& box:codeBoxes_)shift(box.rect);
    for(auto& box:quoteBars_) {if(box.rect.top()<=old.top() && box.rect.bottom()>=old.bottom())box.rect.setBottom(box.rect.bottom()+delta);else shift(box.rect);}
    for(auto& box:ruleLines_)if(box.from.y()>=old.bottom()){box.from.ry()+=delta;box.to.ry()+=delta;}
    for(auto& box:imageBoxes_)shift(box.rect);
    for(auto& box:tableBoxes_)if(box.rect.top()>=old.bottom()){
      box.rect.translate(0,delta);for(auto& row:box.rows)row+=delta;for(auto& line:box.grid)line.translate(0,delta);
    }
    for(auto& region:horizontalRegions_){shift(region.rect);shift(region.track);shift(region.thumb);shift(region.copy);}
  }
  blockRectCache_[block.blockNumber()]=rect;
  // Refresh just this paragraph's inline pills; later paragraphs translate.
  for(int i=inlineBoxes_.size()-1;i>=0;--i){auto& box=inlineBoxes_[i];if(box.rect.center().y()>=old.top() && box.rect.center().y()<=old.bottom() && (!table || (box.rect.center().x()>=old.left() && box.rect.center().x()<=old.right())))inlineBoxes_.removeAt(i);else shift(box.rect);}
  QTextLayout* layout=block.layout();
  for(auto it=block.begin();!it.atEnd();++it){const auto fragment=it.fragment();const auto format=fragment.charFormat();if(!format.boolProperty(InlineCodeProperty))continue;
    const int from=fragment.position()-block.position(),to=from+fragment.length();
    for(int i=0;i<layout->lineCount();++i){const auto line=layout->lineAt(i);const int start=qMax(from,line.textStart()),end=qMin(to,line.textStart()+line.textLength());if(start>=end)continue;
      const QFontMetricsF metrics(format.font());const qreal height=metrics.height()+kInlineCodePadY*2;
      inlineBoxes_.append({QRectF(rect.left()+line.cursorToX(start)-kInlineCodePadX,rect.top()+line.y()+(line.height()-height)/2,line.cursorToX(end)-line.cursorToX(start)+kInlineCodePadX*2,height)});
    }
  }
  if(block.blockFormat().intProperty(RoleProperty)==RoleCode) {
    const QRectF textBounds=codeTextBounds(block,rect);
    for(auto& box:codeBoxes_)if(qAbs(box.rect.top()-(old.top()-16))<0.5)box.rect=QRectF(0,textBounds.top()-16,contentWidth(),textBounds.height()+32);
    for(auto& region:horizontalRegions_)if(region.blockPosition==block.position()) {
      region.rect.setTop(textBounds.top());region.rect.setHeight(textBounds.height());qreal natural=0;
      for(int i=0;i<layout->lineCount();++i)natural=qMax(natural,layout->lineAt(i).naturalTextWidth()+32);
      region.maximum=qMax<qreal>(0,natural-region.rect.width());region.scroll=qBound<qreal>(0,region.scroll,region.maximum);
      region.track.moveTop(textBounds.bottom()+7);const qreal thumb=qMin(region.track.width(),qMax<qreal>(24,region.track.width()*region.rect.width()/qMax(region.rect.width(),natural)));
      region.thumb=QRectF(region.track.left()+(region.maximum>0?region.scroll/region.maximum*(region.track.width()-thumb):0),region.track.top(),thumb,4);
    }
  }
  updateScrollRange();layoutRawSurfaces();viewport()->update();
}
