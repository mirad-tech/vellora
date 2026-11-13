#include <QtWidgets>
#include <QtTest>
#include <QAccessible>
#include "bridge.h"
#include "document_view.h"

// All text is generated test data. No screen reader, OS accessibility setting,
// production file, clipboard or external service is used by these regressions.
namespace {
struct SeenEvent {
  QAccessible::Event type;
  QObject* object;
  int position = -1;
  QString removed;
  QString inserted;
};
QVector<SeenEvent> seen;
void recordEvent(QAccessibleEvent* event) {
  SeenEvent entry{event->type(), event->object()};
  if (event->type() == QAccessible::TextUpdated) {
    auto* change = static_cast<QAccessibleTextUpdateEvent*>(event);
    entry.position = change->changePosition();
    entry.removed = change->textRemoved();
    entry.inserted = change->textInserted();
  }
  seen.append(entry);
}
bool received(QObject* object, QAccessible::Event type) {
  return std::any_of(seen.cbegin(), seen.cend(), [=](const auto& event) { return event.object == object && event.type == type; });
}
}

class AccessibilityRegressions : public QObject {
  Q_OBJECT
  static void load(DocumentView& view, const QString& markdown, QSize size = QSize(800, 500)) {
    view.resize(size);
    view.setPlan(bridge::planFor(markdown).value("plan").toObject(), QString());
    view.show();
    view.setFocus();
    QCoreApplication::processEvents();
  }
  static QAccessibleInterface* interface(DocumentView& view) { return QAccessible::queryAccessibleInterface(&view); }
  static int find(DocumentView& view, const QString& text) { return view.document()->find(text).selectionStart(); }
  static void undo(DocumentView& view) { QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier); QCoreApplication::processEvents(); }
  static QList<QAccessibleInterface*> semanticChildren(QAccessibleInterface* parent, QAccessible::Role role) {
    QList<QAccessibleInterface*> found;
    for (int i = 0; i < parent->childCount(); ++i) {
      auto* item = parent->child(i);
      if (!item || item->object()) continue;
      if (item->role() == role) found.append(item);
      found.append(semanticChildren(item, role));
    }
    return found;
  }
 private slots:
  void constructionAndLifecycle() {
    for (int i = 0; i != 12; ++i) {
      DocumentView view;
      auto* access = interface(view);
      QVERIFY(access);
      auto* text = access->textInterface();
      QVERIFY(text);
      QCOMPARE(text->characterCount(), 0);
      QVERIFY(access->state().readOnly);
      QVERIFY(!access->editableTextInterface());
      load(view, "Body\n");
      QVERIFY(access->editableTextInterface());
      QCOMPARE(text->text(0, -1), view.document()->toPlainText());
      view.setEmptyState();
      QCOMPARE(text->characterCount(), 0);
      QVERIFY(text->text(0, -1).isEmpty());
      QVERIFY(access->state().readOnly);
      QVERIFY(!access->editableTextInterface());
      // Leave a queued update pending, then destroy both view and interface.
      load(view, "Replacement\n");
      view.setEmptyState();
    }
    QCoreApplication::processEvents();
  }

  void readsWholeDocument_data() {
    QTest::addColumn<QString>("markdown");
    QTest::newRow("body") << QString("# Heading\n\nBody **bold** and `code`.\n\n- One\n- Two\n");
    QTest::newRow("utf16") << QString::fromUtf8("Chinese \xe4\xb8\xad\xe6\x96\x87 \xf0\x9f\x98\x80 e\xcc\x81 RTL \xd7\xa9\xd7\x9c\xd7\x95\xd7\x9d\n");
    QTest::newRow("table") << QString("| alpha | beta |\n| --- | --- |\n| gamma | delta |\n\nTail\n");
    QTest::newRow("raw") << QString("<div><p>Nested preview</p></div>\n\nTail\n");
    QTest::newRow("object") << QString("Before ![alternative](missing.png) after\n");
  }
  void readsWholeDocument() {
    QFETCH(QString, markdown);
    DocumentView view; load(view, markdown);
    auto* access = interface(view);
    QVERIFY(access);
    auto* text = access->textInterface();
    QVERIFY(text);
    QCOMPARE(text->characterCount(), view.document()->characterCount() - 1);
    QCOMPARE(text->text(0, -1), view.document()->toPlainText());
    QCOMPARE(text->text(0, -1).size(), text->characterCount());
    QCOMPARE(access->text(QAccessible::Value), text->text(0, -1));
    const QString content = text->text(0, -1);
    for (int position = 0; position < text->characterCount(); ++position)
      QCOMPARE(text->text(position, position + 1), content.mid(position, 1));
    QVERIFY(text->text(-2, 1).isEmpty());
    QVERIFY(text->text(1, 0).isEmpty());
    QVERIFY(text->text(0, text->characterCount() + 1).isEmpty());
  }

  void selectionAndUtf16() {
    DocumentView view; load(view, QString::fromUtf8("alpha \xf0\x9f\x98\x80 omega\n"));
    auto* text = interface(view)->textInterface();
    const int first = find(view, "alpha"), smile = find(view, QString::fromUtf8("\xf0\x9f\x98\x80"));
    text->addSelection(first, first + 5);
    QCOMPARE(text->selectionCount(), 1);
    int start = 99, end = 99; text->selection(0, &start, &end);
    QCOMPARE(start, first); QCOMPARE(end, first + 5);
    QCOMPARE(text->cursorPosition(), first + 5);
    text->setSelection(0, first + 5, first);
    QCOMPARE(text->cursorPosition(), first);
    QCOMPARE(view.selectionState(), qMakePair(first + 5, first));
    const auto old = view.selectionState();
    text->setSelection(1, 0, 2); QCOMPARE(view.selectionState(), old);
    text->setCursorPosition(smile + 1); QCOMPARE(view.selectionState(), old);
    text->setCursorPosition(-1); QCOMPARE(view.selectionState(), old);
    text->setCursorPosition(text->characterCount() + 1); QCOMPARE(view.selectionState(), old);
    text->selection(1, &start, &end); QCOMPARE(start, -1); QCOMPARE(end, -1);
    text->removeSelection(0); QCOMPARE(text->selectionCount(), 0);
    text->setCursorPosition(smile + 2); QCOMPARE(text->cursorPosition(), smile + 2);
    QVERIFY(!view.hasPendingEdits());
    QVERIFY(!view.document()->isUndoAvailable());
  }

  void textBoundaries() {
    DocumentView view;
    load(view, QString::fromUtf8("alpha \xf0\x9f\x98\x80 e\xcc\x81 omega. Second sentence. ") + QString("wrapping words ").repeated(20) + "\n\nTail\n", QSize(380, 500));
    auto* text = interface(view)->textInterface();
    int start = -9, end = -9;
    const int alpha = find(view, "alpha"), smile = find(view, QString::fromUtf8("\xf0\x9f\x98\x80"));
    QCOMPARE(text->textAtOffset(alpha + 1, QAccessible::WordBoundary, &start, &end), QString("alpha"));
    QCOMPARE(start, alpha); QCOMPARE(end, alpha + 5);
    QCOMPARE(text->textAtOffset(smile + 1, QAccessible::CharBoundary, &start, &end), QString::fromUtf8("\xf0\x9f\x98\x80"));
    QCOMPARE(end - start, 2);
    const int combining = find(view, QString::fromUtf8("e\xcc\x81"));
    QCOMPARE(text->textAtOffset(combining + 1, QAccessible::CharBoundary, &start, &end), QString::fromUtf8("e\xcc\x81"));
    text->setCursorPosition(alpha + 1);
    QCOMPARE(text->textAtOffset(-2, QAccessible::WordBoundary, &start, &end), QString("alpha"));
    const QString line = text->textAtOffset(alpha, QAccessible::LineBoundary, &start, &end);
    QVERIFY(!line.isEmpty());
    const int lineEnd = end;
    const QString next = text->textAfterOffset(alpha, QAccessible::LineBoundary, &start, &end);
    QVERIFY(!next.isEmpty()); QCOMPARE(start, lineEnd);
    QCOMPARE(text->textBeforeOffset(lineEnd, QAccessible::LineBoundary, &start, &end), line);
    QVERIFY(text->textAtOffset(alpha, QAccessible::ParagraphBoundary, &start, &end).size() > line.size());
    QCOMPARE(text->textAtOffset(-1, QAccessible::NoBoundary, &start, &end), text->text(0, -1));
    QVERIFY(text->textAtOffset(-3, QAccessible::WordBoundary, &start, &end).isEmpty());
    QCOMPARE(start, -1); QCOMPARE(end, -1);
    QVERIFY(text->textBeforeOffset(0, QAccessible::CharBoundary, &start, &end).isEmpty());
    QVERIFY(text->textAfterOffset(text->characterCount(), QAccessible::CharBoundary, &start, &end).isEmpty());
  }

  void geometryAndScroll() {
    DocumentView view; load(view, "Start\n\n" + QString("Line of text.\n\n").repeated(70) + "Target text\n", QSize(600, 300));
    auto* text = interface(view)->textInterface();
    const int target = find(view, "Target");
    const auto old = view.selectionState();
    text->scrollToSubstring(target, target + 6);
    QCOMPARE(view.selectionState(), old);
    QVERIFY(view.scrollValue() > 0);
    const QRect rectangle = text->characterRect(target);
    QVERIFY(!rectangle.isEmpty());
    const QRect screen(view.viewport()->mapToGlobal(QPoint()), view.viewport()->size());
    QVERIFY(screen.intersects(rectangle));
    const int hit = text->offsetAtPoint(QPoint(rectangle.left() + 1, rectangle.center().y()));
    QVERIFY(hit == target || hit == target + 1);
    QCOMPARE(text->offsetAtPoint(screen.topLeft() - QPoint(100, 100)), -1);
    QVERIFY(text->characterRect(-1).isEmpty());
    QVERIFY(text->characterRect(text->characterCount() + 1).isEmpty());
    QVERIFY(!view.hasPendingEdits());
  }

  void horizontalCodeGeometry() {
    DocumentView view; load(view, "```txt\n" + QString(180, 'x') + "TARGET\n```\n", QSize(500, 300));
    auto* text = interface(view)->textInterface();
    const int target = find(view, "TARGET");
    text->setCursorPosition(target);
    const QRect rectangle = text->characterRect(target);
    QVERIFY(!rectangle.isEmpty());
    const QRect screen(view.viewport()->mapToGlobal(QPoint()), view.viewport()->size());
    QVERIFY(screen.intersects(rectangle));
    const int hit = text->offsetAtPoint(QPoint(rectangle.left() + 1, rectangle.center().y()));
    QVERIFY(hit == target || hit == target + 1);
  }

  void editsUndoAndDirty_data() {
    QTest::addColumn<int>("operation");
    QTest::newRow("insert") << 0;
    QTest::newRow("delete") << 1;
    QTest::newRow("replace") << 2;
  }
  void editsUndoAndDirty() {
    QFETCH(int, operation);
    DocumentView view; load(view, "Body text\n\nUntouched **bold**\n");
    auto* access = interface(view);
    auto* edit = access->editableTextInterface(); QVERIFY(edit);
    const QString baseline = view.document()->toPlainText();
    const int position = find(view, "text");
    QSignalSpy changes(&view, &DocumentView::contentEdited);
    if (operation == 0) edit->insertText(position, "new ");
    else if (operation == 1) edit->deleteText(position, position + 4);
    else edit->replaceText(position, position + 4, "replacement");
    QVERIFY(!changes.isEmpty());
    QVERIFY(view.hasPendingEdits());
    QVERIFY(view.document()->isUndoAvailable());
    QCOMPARE(view.pendingEdits().size(), 1);
    QVERIFY(view.document()->toPlainText().contains("Untouched bold"));
    undo(view);
    QCOMPARE(view.document()->toPlainText(), baseline);
    QVERIFY(!view.hasPendingEdits());
    QVERIFY(!view.document()->isUndoAvailable());
  }

  void rejectsInvalidAndImeEdits() {
    DocumentView view; load(view, QString::fromUtf8("Body \xf0\x9f\x98\x80 text\n"));
    auto* access = interface(view); auto* edit = access->editableTextInterface(); QVERIFY(edit);
    auto* text = access->textInterface();
    const auto baseline = view.document()->toPlainText();
    const int smile = find(view, QString::fromUtf8("\xf0\x9f\x98\x80"));
    edit->deleteText(smile, smile + 1);
    edit->insertText(smile + 1, "X");
    edit->replaceText(-1, 2, "X");
    edit->replaceText(0, text->characterCount() + 1, "X");
    QCOMPARE(view.document()->toPlainText(), baseline);
    QVERIFY(!view.hasPendingEdits());
    text->setCursorPosition(smile);
    QInputMethodEvent preedit("composition", {}); QApplication::sendEvent(&view, &preedit);
    QVERIFY(view.isComposing());
    const auto selection = view.selectionState();
    edit->insertText(smile, "X"); text->setCursorPosition(smile + 2);
    QCOMPARE(view.selectionState(), selection);
    QCOMPARE(view.document()->toPlainText(), baseline);
    QInputMethodEvent cancel; QApplication::sendEvent(&view, &cancel);
    QVERIFY(!view.isComposing());
    edit->replaceText(smile, smile + 2, "OK");
    QVERIFY(view.hasPendingEdits()); undo(view);
    QCOMPARE(view.document()->toPlainText(), baseline);
    view.setEnabled(false);
    QVERIFY(access->state().readOnly);
    QVERIFY(!access->editableTextInterface());
    edit->insertText(smile, "X");
    QCOMPARE(view.document()->toPlainText(), baseline);
  }

  void rawPreviewReadonlyAndSourceVisibility() {
    DocumentView view; load(view, "<div><p>Nested preview</p></div>\n\nTail\n");
    const auto previews = view.findChildren<DocumentView*>(); QVERIFY(!previews.isEmpty());
    auto* preview = previews.first();
    auto* nested = interface(*preview);
    QVERIFY(nested->textInterface());
    QVERIFY(nested->textInterface()->text(0, -1).contains("Nested preview"));
    QVERIFY(nested->state().readOnly);
    QVERIFY(!nested->editableTextInterface());
    auto* parent = interface(view); auto* edit = parent->editableTextInterface(); QVERIFY(edit);
    const QString baseline = view.document()->toPlainText();
    const int raw = find(view, "<div>");
    edit->insertText(raw, "X");
    QCOMPARE(view.document()->toPlainText(), baseline);
    QVERIFY(!view.hasPendingEdits());
    QVERIFY(parent->textInterface()->characterRect(raw).isEmpty());
    // Inline source/preview toggles were removed at the user's request. Raw
    // search reveal still exposes the protected source through the existing
    // keyboard/search path, without weakening the preview's read-only state.
    QVERIFY(view.findChildren<QPushButton*>().isEmpty());
    view.setSearchQuery(QStringLiteral("<div>"), true);
    QCoreApplication::processEvents();
    QVERIFY(view.searchMatchCount() > 0);
    edit->insertText(raw, "X");
    QVERIFY(view.hasPendingEdits());
    QVERIFY(!parent->textInterface()->characterRect(raw).isEmpty());
    undo(view); QCOMPARE(view.document()->toPlainText(), baseline); QVERIFY(!view.hasPendingEdits());
  }

  void tableTextEditsDoNotDeleteFrames() {
    DocumentView view; load(view, "| alpha | beta |\n| --- | --- |\n| gamma | delta |\n");
    auto* access = interface(view); auto* edit = access->editableTextInterface(); QVERIFY(edit);
    const QString baseline = view.document()->toPlainText();
    for (int position = 0; position < view.document()->characterCount() - 1; ++position) {
      const auto ch = view.document()->characterAt(position);
      if (ch != QChar(0xfdd0) && ch != QChar(0xfdd1)) continue;
      edit->deleteText(position, position + 1);
      QCOMPARE(view.document()->toPlainText(), baseline);
    }
    const int gamma = find(view, "gamma");
    edit->replaceText(gamma, gamma + 5, "changed");
    QVERIFY(view.hasPendingEdits());
    QVERIFY(view.pendingEdits().first().second.contains("changed"));
    undo(view); QCOMPARE(view.document()->toPlainText(), baseline); QVERIFY(!view.hasPendingEdits());
  }

  void crossBlockAndReadonlyRanges() {
    DocumentView view; load(view, "First paragraph\n\nSecond paragraph\n\n<div><p>Protected preview</p></div>\n\nTail\n");
    auto* access = interface(view); auto* edit = access->editableTextInterface(); QVERIFY(edit);
    const QString baseline = view.document()->toPlainText();
    const int first = find(view, "First"), second = find(view, "Second"), tail = find(view, "Tail");
    edit->replaceText(first, second + 6, "Combined");
    QVERIFY(view.hasPendingEdits());
    undo(view); QCOMPARE(view.document()->toPlainText(), baseline); QVERIFY(!view.hasPendingEdits());
    edit->deleteText(second, tail + 4);
    QCOMPARE(view.document()->toPlainText(), baseline); QVERIFY(!view.hasPendingEdits());
    QVERIFY(!view.document()->isUndoAvailable());
  }

  void formattingAndReadonlyAttributes() {
    DocumentView view; load(view, "plain **bold** and *italic*\n");
    auto* text = interface(view)->textInterface();
    int start = -1, end = -1;
    const int bold = find(view, "bold"), italic = find(view, "italic");
    QString attrs = text->attributes(bold, &start, &end);
    QVERIFY(start <= bold && end > bold);
    QVERIFY(attrs.contains("font-weight:700;")); QVERIFY(attrs.contains("read-only:false;"));
    attrs = text->attributes(italic, &start, &end); QVERIFY(attrs.contains("font-style:italic;"));
    QVERIFY(text->attributes(-1, &start, &end).isEmpty()); QCOMPARE(start, -1); QCOMPARE(end, -1);
  }

  void headingLinkAndImageSemantics() {
    DocumentView view; load(view, "## Heading [bold **link**](https://example.invalid/path \"Link title\")\n\n![Diagram](missing.png \"Image title\") ![Diagram](missing.png \"Image title\")\n");
    auto* root = interface(view); QVERIFY(root->textInterface()); QVERIFY(root->editableTextInterface());
    const QString baseline = root->textInterface()->text(0, -1);
    const auto headings = semanticChildren(root, QAccessible::Heading); QCOMPARE(headings.size(), 1);
    auto* heading = headings.first();
    QCOMPARE(heading->text(QAccessible::Name), QString("Heading bold link"));
    QVERIFY(heading->attributesInterface());
    QCOMPARE(heading->attributesInterface()->attributeValue(QAccessible::Attribute::Level).toInt(), 2);
    QCOMPARE(heading->parent(), root); QCOMPARE(root->child(root->indexOfChild(heading)), heading);
    const auto links = semanticChildren(root, QAccessible::Link); QCOMPARE(links.size(), 1);
    auto* link = links.first(); QVERIFY(link->hyperlinkInterface());
    QCOMPARE(link->parent(), heading);
    QCOMPARE(link->text(QAccessible::Name), QString("bold link"));
    QCOMPARE(link->text(QAccessible::Description), QString("Link title"));
    QCOMPARE(link->hyperlinkInterface()->anchorTarget(), QString("https://example.invalid/path"));
    QCOMPARE(root->textInterface()->text(link->hyperlinkInterface()->startIndex(), link->hyperlinkInterface()->endIndex()), QString("bold link"));
    QVERIFY(!link->rect().isEmpty());
    QCOMPARE(heading->childAt(link->rect().center().x(), link->rect().center().y()), link);
    QSignalSpy activated(&view, &DocumentView::linkActivated);
    const auto oldSelection = view.selectionState();
    QVERIFY(link->actionInterface()); link->actionInterface()->doAction(QAccessibleActionInterface::pressAction());
    QCOMPARE(activated.size(), 1); QCOMPARE(activated.first().first().toString(), QString("https://example.invalid/path"));
    QCOMPARE(view.selectionState(), oldSelection); // no synthetic focus/cursor changes
    view.setEnabled(false); link->actionInterface()->doAction(QAccessibleActionInterface::pressAction()); QCOMPARE(activated.size(), 1); view.setEnabled(true);
    const auto images = semanticChildren(root, QAccessible::Graphic); QCOMPARE(images.size(), 2);
    QVERIFY(images.first() != images.last());
    for (auto* image : images) {
      QVERIFY(image->imageInterface()); QCOMPARE(image->text(QAccessible::Name), QString("Diagram"));
      QCOMPARE(image->imageInterface()->imageDescription(), QString("Diagram"));
      QCOMPARE(image->text(QAccessible::Description), QString("Image title"));
      QVERIFY(!image->imageInterface()->imageSize().isEmpty());
      QCOMPARE(image->imageInterface()->imagePosition(), image->rect().topLeft());
      QVERIFY(!image->editableTextInterface()); QVERIFY(!image->state().focusable);
    }
    QCOMPARE(root->textInterface()->text(0, -1), baseline); QVERIFY(!view.hasPendingEdits());
  }

  void tableHeadersCellsAndGeometry() {
    DocumentView view; load(view, "| First | Second |\n| --- | --- |\n| Alpha | [Beta](relative.md) |\n");
    auto* root = interface(view); const auto tables = semanticChildren(root, QAccessible::Table); QCOMPARE(tables.size(), 1);
    auto* table = tables.first(); auto* model = table->tableInterface(); QVERIFY(model);
    QCOMPARE(model->rowCount(), 2); QCOMPARE(model->columnCount(), 2); QCOMPARE(table->childCount(), 4);
    QCOMPARE(model->columnDescription(1), QString("Second"));
    QVERIFY(!model->cellAt(-1, 0)); QVERIFY(!model->cellAt(2, 0)); QVERIFY(!model->cellAt(0, 2));
    for (int row = 0; row != 2; ++row) for (int col = 0; col != 2; ++col) {
      auto* cell = model->cellAt(row, col); QVERIFY(cell); QCOMPARE(cell->parent(), table);
      QCOMPARE(table->child(table->indexOfChild(cell)), cell);
      auto* data = cell->tableCellInterface(); QVERIFY(data); QCOMPARE(data->table(), table);
      QCOMPARE(data->rowIndex(), row); QCOMPARE(data->columnIndex(), col);
      QCOMPARE(data->rowExtent(), 1); QCOMPARE(data->columnExtent(), 1);
      QCOMPARE(cell->role(), row == 0 ? QAccessible::ColumnHeader : QAccessible::Cell);
      if (row == 1) QCOMPARE(data->columnHeaderCells(), QList<QAccessibleInterface*>{model->cellAt(0, col)});
      QVERIFY(data->rowHeaderCells().isEmpty()); QVERIFY(!cell->rect().isEmpty());
      QCOMPARE(table->childAt(cell->rect().center().x(), cell->rect().center().y()), cell);
    }
    QCOMPARE(model->cellAt(1, 0)->text(QAccessible::Name), QString("Alpha"));
    QCOMPARE(model->selectedCellCount(), 0); QVERIFY(!model->selectRow(1)); QVERIFY(!model->selectColumn(1));
    const auto links = semanticChildren(table, QAccessible::Link); QCOMPARE(links.size(), 1);
    QCOMPARE(links.first()->parent(), model->cellAt(1, 1));
    QVERIFY(!view.hasPendingEdits());
  }

  void imageMetadataDoesNotTurnOrdinaryTextIntoImages() {
    DocumentView view; load(view, "[![Alt](missing.png)![Alt](missing.png)](relative.md)\n");
    auto* root = interface(view);
    auto links = semanticChildren(root, QAccessible::Link); QCOMPARE(links.size(), 1);
    QCOMPARE(links.first()->text(QAccessible::Name), QString("AltAlt"));
    QCOMPARE(semanticChildren(root, QAccessible::Graphic).size(), 2);
    auto image = view.document()->find(QString(QChar::ObjectReplacementCharacter)); QVERIFY(!image.isNull());
    const auto format = image.charFormat();
    image.setPosition(image.selectionStart()); image.insertText("literal", format);
    const int revision = view.document()->revision();
    links = semanticChildren(root, QAccessible::Link); QCOMPARE(links.size(), 1);
    QCOMPARE(links.first()->text(QAccessible::Name), QString("literalAltAlt"));
    QCOMPARE(semanticChildren(root, QAccessible::Graphic).size(), 2);
    QCOMPARE(view.document()->revision(), revision);
    QVERIFY(root->textInterface()->text(0, -1).contains("literal"));
  }

  void mergedRawTableSemantics() {
    DocumentView view; load(view, "<table><tr><th colspan=\"2\">Group</th></tr><tr><td rowspan=\"2\">A</td><td>B</td></tr><tr><td>C</td></tr></table>\n");
    const auto previews = view.findChildren<DocumentView*>(); QVERIFY(!previews.isEmpty());
    auto* root = interface(*previews.first()); QVERIFY(root->state().readOnly);
    const auto tables = semanticChildren(root, QAccessible::Table); QCOMPARE(tables.size(), 1);
    auto* model = tables.first()->tableInterface(); QCOMPARE(model->rowCount(), 3); QCOMPARE(model->columnCount(), 2);
    QCOMPARE(model->cellAt(0, 0), model->cellAt(0, 1));
    QCOMPARE(model->cellAt(0, 0)->tableCellInterface()->columnExtent(), 2);
    QCOMPARE(model->cellAt(1, 0), model->cellAt(2, 0));
    QCOMPARE(model->cellAt(1, 0)->tableCellInterface()->rowExtent(), 2);
    QCOMPARE(model->cellAt(2, 1)->text(QAccessible::Name), QString("C"));
    QCOMPARE(model->cellAt(2, 1)->tableCellInterface()->columnHeaderCells(), QList<QAccessibleInterface*>{model->cellAt(0, 0)});
    QVERIFY(!view.hasPendingEdits());
    load(view, "<table><tr><td>Body A</td><td>Body B</td></tr></table>\n");
    auto* noHeaderRoot = interface(*view.findChildren<DocumentView*>().first());
    auto* noHeader = semanticChildren(noHeaderRoot, QAccessible::Table).first()->tableInterface();
    QCOMPARE(noHeader->cellAt(0, 0)->role(), QAccessible::Cell); QVERIFY(noHeader->columnDescription(0).isEmpty());
  }

  void authoredHeadersDoNotPromoteDataCells() {
    const QString source = "<table><tr><th scope='COL' colspan='2'>Shared</th><td>Not header</td></tr>"
                           "<tr><th scope='Row' rowspan='2'>Rows</th><td>A</td><td>B</td></tr>"
                           "<tr><td>C</td><td>D</td></tr></table>\n";
    DocumentView view; load(view, source);
    const QString rawText = view.document()->toPlainText();
    const auto previews = view.findChildren<DocumentView*>(); QVERIFY(!previews.isEmpty());
    auto* root = interface(*previews.first()); QVERIFY(root->state().readOnly);
    const auto tables = semanticChildren(root, QAccessible::Table); QCOMPARE(tables.size(), 1);
    auto* model = tables.first()->tableInterface(); QCOMPARE(model->rowCount(), 3); QCOMPARE(model->columnCount(), 3);
    auto* columnHeader = model->cellAt(0, 0); auto* rowHeader = model->cellAt(1, 0);
    QCOMPARE(columnHeader->role(), QAccessible::ColumnHeader); QCOMPARE(columnHeader, model->cellAt(0, 1));
    QCOMPARE(model->cellAt(0, 2)->role(), QAccessible::Cell);
    QCOMPARE(rowHeader->role(), QAccessible::RowHeader); QCOMPARE(rowHeader, model->cellAt(2, 0));
    QCOMPARE(rowHeader->tableCellInterface()->rowExtent(), 2);
    auto* c = model->cellAt(2, 1); QCOMPARE(c->text(QAccessible::Name), QString("C"));
    QCOMPARE(c->tableCellInterface()->columnHeaderCells(), QList<QAccessibleInterface*>{columnHeader});
    QCOMPARE(c->tableCellInterface()->rowHeaderCells(), QList<QAccessibleInterface*>{rowHeader});
    QCOMPARE(model->cellAt(2, 2)->tableCellInterface()->rowHeaderCells(), QList<QAccessibleInterface*>{rowHeader});
    QVERIFY(model->cellAt(2, 2)->tableCellInterface()->columnHeaderCells().isEmpty());
    QVERIFY(rowHeader->tableCellInterface()->rowHeaderCells().isEmpty());
    QCOMPARE(model->columnDescription(1), QString("Shared")); QVERIFY(model->columnDescription(2).isEmpty());
    QCOMPARE(model->rowDescription(2), QString("Rows")); QVERIFY(model->rowDescription(0).isEmpty());
    auto* attributes = rowHeader->attributesInterface(); QVERIFY(attributes);
    const auto metadata = attributes->attributeValue(QAccessible::Attribute::Custom).value<QHash<QString, QString>>();
    QCOMPARE(metadata.value("tag"), QString("th")); QCOMPARE(metadata.value("scope"), QString("row"));
    QVERIFY(!attributes->attributeValue(QAccessible::Attribute::Level).isValid());
    QVERIFY(!view.hasPendingEdits()); QCOMPARE(view.document()->toPlainText(), rawText);
    // The generated merge separator/padding must disappear, but an authored
    // zero-width space and trailing ordinary space must survive unchanged.
    load(view, "<table><tr><th colspan='2'>Kept&#8203; </th></tr></table>\n");
    auto* keptRoot = interface(*view.findChildren<DocumentView*>().first());
    auto* kept = semanticChildren(keptRoot, QAccessible::Table).first()->tableInterface();
    QCOMPARE(kept->columnDescription(1), QString("Kept") + QChar(0x200B) + QLatin1Char(' '));
    QVERIFY(!view.hasPendingEdits());
  }

  void ambiguousAndGroupHeadersDoNotInventAssociations() {
    DocumentView view; load(view, "<table><tr><td>Data</td><td>Data</td><td>Data</td></tr>"
                                 "<tr><th scope='rowgroup'>Group</th><th scope='colgroup'>Group</th><th scope='bogus'>Unknown</th></tr>"
                                 "<tr><th>Auto</th><td>Value</td><td>Other</td></tr></table>\n");
    const auto previews = view.findChildren<DocumentView*>(); QVERIFY(!previews.isEmpty());
    auto* root = interface(*previews.first()); const auto tables = semanticChildren(root, QAccessible::Table); QCOMPARE(tables.size(), 1);
    auto* model = tables.first()->tableInterface();
    QCOMPARE(model->cellAt(1, 0)->role(), QAccessible::RowHeader);
    QCOMPARE(model->cellAt(1, 1)->role(), QAccessible::ColumnHeader);
    auto* unknown = model->cellAt(1, 2); QCOMPARE(unknown->role(), QAccessible::Cell);
    auto metadata = unknown->attributesInterface()->attributeValue(QAccessible::Attribute::Custom).value<QHash<QString, QString>>();
    QCOMPARE(metadata.value("tag"), QString("th")); QCOMPARE(metadata.value("scope"), QString("unknown"));
    auto* automatic = model->cellAt(2, 0); QCOMPARE(automatic->role(), QAccessible::Cell);
    metadata = automatic->attributesInterface()->attributeValue(QAccessible::Attribute::Custom).value<QHash<QString, QString>>();
    QCOMPARE(metadata.value("tag"), QString("th")); QCOMPARE(metadata.value("scope"), QString("auto"));
    QVERIFY(model->cellAt(2, 1)->tableCellInterface()->columnHeaderCells().isEmpty());
    QVERIFY(model->cellAt(1, 2)->tableCellInterface()->rowHeaderCells().isEmpty());
    QVERIFY(model->columnDescription(1).isEmpty()); QVERIFY(model->rowDescription(1).isEmpty());
    QVERIFY(!view.hasPendingEdits());
  }

  void listHierarchyTextAndBounds() {
    DocumentView view;
    load(view, "- First [link](relative.md)\n\n  Continued text\n\n  3. Inner ![Alt](missing.png)\n  4. Next\n\n- Last\n\nAfter\n\n5. Five\n6. Six\n");
    auto* root = interface(view); QVERIFY(root->editableTextInterface());
    const auto lists = semanticChildren(root, QAccessible::List); QCOMPARE(lists.size(), 3);
    const auto items = semanticChildren(root, QAccessible::ListItem); QCOMPARE(items.size(), 6);
    auto* outer = lists.at(0); auto* inner = lists.at(1); auto* ordered = lists.at(2);
    QCOMPARE(outer->parent(), root); QCOMPARE(ordered->parent(), root);
    QCOMPARE(outer->childCount(), 2); QCOMPARE(inner->childCount(), 2);
    auto* first = outer->child(0); QCOMPARE(inner->parent(), first);
    QCOMPARE(first->text(QAccessible::Name), QString("First link\nContinued text"));
    QCOMPARE(outer->child(1)->text(QAccessible::Name), QString("Last"));
    QCOMPARE(inner->child(0)->text(QAccessible::Name), QString("Inner Alt"));
    QCOMPARE(ordered->child(0)->text(QAccessible::Name), QString("Five"));
    const auto orderedMetadata = ordered->attributesInterface()->attributeValue(QAccessible::Attribute::Custom).value<QHash<QString, QString>>();
    QCOMPARE(orderedMetadata.value("tag"), QString("ol")); QCOMPARE(orderedMetadata.value("start"), QString("5"));
    for (auto* item : items) {
      QVERIFY(item->attributesInterface()); QVERIFY(!item->editableTextInterface()); QVERIFY(!item->state().focusable);
      QCOMPARE(item->parent()->child(item->parent()->indexOfChild(item)), item);
      QVERIFY(!item->rect().isEmpty()); QVERIFY(item->parent()->rect().contains(item->rect()));
      QCOMPARE(item->parent()->childAt(item->rect().center().x(), item->rect().center().y()), item);
      const auto metadata = item->attributesInterface()->attributeValue(QAccessible::Attribute::Custom).value<QHash<QString, QString>>();
      QCOMPARE(metadata.value("setsize"), QString("2"));
      QCOMPARE(item->attributesInterface()->attributeValue(QAccessible::Attribute::Level).toInt(), item->parent() == inner ? 2 : 1);
    }
    const auto links = semanticChildren(root, QAccessible::Link); QCOMPARE(links.size(), 1); QCOMPARE(links.first()->parent(), first);
    const auto images = semanticChildren(root, QAccessible::Graphic); QCOMPARE(images.size(), 1); QCOMPARE(images.first()->parent(), inner->child(0));
    QVERIFY(!view.hasPendingEdits()); QVERIFY(!view.document()->isUndoAvailable());
  }

  void listsKeepHeadingAndTableInterfaces() {
    DocumentView view; load(view, "- ## Item heading\n\n  | H | J |\n  | --- | --- |\n  | A | B |\n\n- Last\n");
    auto* root = interface(view); const auto lists = semanticChildren(root, QAccessible::List); QCOMPARE(lists.size(), 1);
    auto* first = lists.first()->child(0); QCOMPARE(first->role(), QAccessible::ListItem);
    const auto headings = semanticChildren(root, QAccessible::Heading); QCOMPARE(headings.size(), 1);
    QCOMPARE(headings.first()->parent(), first); QCOMPARE(headings.first()->text(QAccessible::Name), QString("Item heading"));
    const auto tables = semanticChildren(root, QAccessible::Table); QCOMPARE(tables.size(), 1); QCOMPARE(tables.first()->parent(), first);
    auto* model = tables.first()->tableInterface(); QVERIFY(model); QCOMPARE(model->cellAt(1, 1)->text(QAccessible::Name), QString("B"));
    QCOMPARE(model->cellAt(0, 0)->role(), QAccessible::ColumnHeader);
    QVERIFY(first->rect().contains(tables.first()->rect())); QVERIFY(root->editableTextInterface()); QVERIFY(!view.hasPendingEdits());
  }

  void listEditsReparentUndoAndInvalidate() {
    DocumentView view; load(view, "- First\n- Second\n");
    auto* root = interface(view); auto* list = semanticChildren(root, QAccessible::List).first();
    auto* first = list->child(0); auto* second = list->child(1);
    const auto firstId = QAccessible::uniqueId(first), secondId = QAccessible::uniqueId(second);
    root->editableTextInterface()->insertText(find(view, "First") + 5, " extended"); root->childCount();
    QCOMPARE(QAccessible::accessibleInterface(firstId)->text(QAccessible::Name), QString("First extended")); QVERIFY(view.hasPendingEdits());
    undo(view); root->childCount(); QCOMPARE(QAccessible::accessibleInterface(firstId)->text(QAccessible::Name), QString("First"));
    root->textInterface()->setCursorPosition(find(view, "Second")); QTest::keyClick(&view, Qt::Key_Tab); QCoreApplication::processEvents(); root->childCount();
    second = QAccessible::accessibleInterface(secondId); QVERIFY(second);
    QCOMPARE(second->attributesInterface()->attributeValue(QAccessible::Attribute::Level).toInt(), 2);
    QCOMPARE(second->parent()->parent(), QAccessible::accessibleInterface(firstId));
    undo(view); root->childCount(); second = QAccessible::accessibleInterface(secondId); QVERIFY(second);
    QCOMPARE(second->attributesInterface()->attributeValue(QAccessible::Attribute::Level).toInt(), 1);
    QCOMPARE(second->parent(), QAccessible::accessibleInterface(firstId)->parent()); QVERIFY(!view.hasPendingEdits());
    load(view, "Replacement\n"); root->childCount(); QVERIFY(!QAccessible::accessibleInterface(firstId)); QVERIFY(!QAccessible::accessibleInterface(secondId));
  }

  void semanticIdentityRefreshAndDeletion() {
    QAccessible::Id retained = 0;
    {
      DocumentView view; load(view, "## Heading\n\n[Link](relative.md)\n");
      auto* root = interface(view); auto* heading = semanticChildren(root, QAccessible::Heading).first();
      retained = QAccessible::uniqueId(heading);
      const auto linkId = QAccessible::uniqueId(semanticChildren(root, QAccessible::Link).first());
      const int at = find(view, "Heading");
      root->editableTextInterface()->insertText(at + 7, " changed");
      QCOMPARE(QAccessible::accessibleInterface(retained), heading);
      QCOMPARE(heading->text(QAccessible::Name), QString("Heading changed"));
      undo(view); QCOMPARE(QAccessible::accessibleInterface(retained), heading); QCOMPARE(heading->text(QAccessible::Name), QString("Heading"));
      load(view, "Plain replacement\n"); root->childCount();
      QVERIFY(!QAccessible::accessibleInterface(retained)); QVERIFY(!QAccessible::accessibleInterface(linkId));
      load(view, "# New heading\n");
      retained = QAccessible::uniqueId(semanticChildren(root, QAccessible::Heading).first());
    }
    QVERIFY(!QAccessible::accessibleInterface(retained));
    QCoreApplication::processEvents();
  }

  void repeatedSemanticQueriesAreStable() {
    QString markdown;
    for (int i = 0; i < 600; ++i) markdown += "## Heading " + QString::number(i) + "\n\n[Link](relative.md) ordinary text.\n\n";
    DocumentView view; load(view, markdown);
    auto* root = interface(view); const int count = root->childCount();
    const auto firstId = QAccessible::uniqueId(root->child(0));
    QElapsedTimer timer; timer.start();
    for (int i = 0; i < 300; ++i) {
      QCOMPARE(root->childCount(), count); QCOMPARE(QAccessible::uniqueId(root->child(0)), firstId);
      auto* hit = root->childAt(view.viewport()->mapToGlobal(QPoint(100, 40)).x(), view.viewport()->mapToGlobal(QPoint(100, 40)).y());
      QVERIFY(hit || !root->rect().isEmpty());
    }
    QVERIFY2(timer.elapsed() < 3000, "Repeated queries must reuse the semantic tree rather than rebuild it");
    QVERIFY(!view.hasPendingEdits()); QVERIFY(!view.document()->isUndoAvailable());
  }

  void emitsTextSelectionAndStateEvents() {
    const bool oldActive = QAccessible::isActive();
    const auto oldHandler = QAccessible::installUpdateHandler(recordEvent);
    QAccessible::setActive(true);
    struct Restore {
      bool active; QAccessible::UpdateHandler handler;
      ~Restore() { QAccessible::installUpdateHandler(handler); QAccessible::setActive(active); seen.clear(); }
    } restore{oldActive, oldHandler};
    DocumentView view; load(view, "Body text\n");
    auto* access = interface(view); auto* text = access->textInterface(); auto* edit = access->editableTextInterface();
    QCoreApplication::processEvents(); seen.clear();
    const int body = find(view, "Body");
    text->setSelection(0, body, body + 4);
    QVERIFY(received(&view, QAccessible::TextSelectionChanged));
    QVERIFY(received(&view, QAccessible::TextCaretMoved));
    seen.clear(); edit->replaceText(body, body + 4, "Changed");
    QVERIFY(received(&view, QAccessible::TextUpdated));
    bool correct = false;
    for (const auto& event : seen)
      if (event.object == &view && event.type == QAccessible::TextUpdated)
        correct |= event.position == body && event.removed == "Body" && event.inserted == "Changed";
    QVERIFY(correct);
    seen.clear(); undo(view); QTRY_VERIFY(received(&view, QAccessible::TextUpdated));
    seen.clear(); view.setEmptyState(); QTRY_VERIFY(received(&view, QAccessible::StateChanged));
  }
};

QTEST_MAIN(AccessibilityRegressions)
#include "accessibility_regressions.moc"
