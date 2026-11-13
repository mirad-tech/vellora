#include <QtWidgets>
#include <QtTest>
#include <algorithm>
#include "bridge.h"
#include "document_view.h"
#include "theme.h"

class BodyLayoutRegressions : public QObject {
  Q_OBJECT
  static void load(DocumentView& view, const QString& source, int width = 820) {
    view.resize(width, 900); view.show();
    view.setPlan(bridge::planFor(source).value("plan").toObject(), {});
    view.setPreviewContext(source); QCoreApplication::processEvents(); view.relayout();
  }
  static QString draft(DocumentView& view, const QString& source) {
    QJsonArray edits;
    for (const auto& edit : view.pendingEdits()) edits.append(QJsonObject{{"index", edit.first}, {"markdown", edit.second}});
    return bridge::spliceSegments(source, edits).value("content").toString();
  }
  static QByteArray bytes(const QString& path) {
    QFile file(path); if (!file.open(QIODevice::ReadOnly)) return {}; return file.readAll();
  }
  static void reportLines(const QTextBlock& block, const QString& name) {
    auto* layout = block.layout();
    qInfo().noquote() << name << "textLength=" << block.text().size() << "lines=" << layout->lineCount()
                      << "indent=" << block.blockFormat().textIndent();
    for (int i = 0; i < layout->lineCount(); ++i) {
      const auto line = layout->lineAt(i);
      qInfo() << "line" << i << "start/length" << line.textStart() << line.textLength()
              << "x/y/height/ascent" << line.x() << line.y() << line.height() << line.ascent();
    }
  }
 private slots:
  void chineseWrappingPreservesExplicitIndent_data() {
    QTest::addColumn<int>("width"); QTest::addColumn<bool>("indent");
    for (int width : {640, 820, 1280}) for (bool indent : {false, true})
      QTest::newRow(qPrintable(QString("%1-%2").arg(width).arg(indent))) << width << indent;
  }
  void chineseWrappingPreservesExplicitIndent() {
    QFETCH(int, width); QFETCH(bool, indent);
    const QString text = (indent ? QString(QChar(0x3000)).repeated(2) : QString()) +
        QStringLiteral("这是一段没有手动换行的中文长段落，用于检查首行空格与自然折行。English words、标点（括号）和数字2026。").repeated(12);
    const QString source = text + "\n"; DocumentView view; load(view, source, width);
    const auto block = view.document()->find(QStringLiteral("这是一段")).block(); QVERIFY(block.isValid());
    reportLines(block, QString("chinese-width-%1-indent-%2").arg(width).arg(indent));
    const qreal twoCharacters = QFontMetricsF(theme::uiFont(16)).horizontalAdvance(QString(QChar(0x3000)).repeated(2));
    QCOMPARE(block.text(), text);
    QVERIFY(qAbs(block.blockFormat().textIndent() - (indent ? 0 : twoCharacters)) <= 0.1);
    auto* layout = block.layout(); QVERIFY(layout->lineCount() > 1);
    const auto first = layout->lineAt(0);
    const qreal advance = first.cursorToX(indent ? 2 : 0) - first.cursorToX(0);
    qInfo() << "explicit-leading-advance" << advance << "contentLeft" << view.contentLeft();
    if (indent) {
      const qreal expected = QFontMetricsF(theme::uiFont(16)).horizontalAdvance(QString(QChar(0x3000)).repeated(2));
      QVERIFY(qAbs(advance - expected) <= 1);
    } else QCOMPARE(advance, qreal(0));
    for (int i = 1; i < layout->lineCount(); ++i) {
      const auto line = layout->lineAt(i);
      QVERIFY(qAbs(line.y() - layout->lineAt(i - 1).y() - 28) < 0.2);
      QVERIFY(qAbs(line.cursorToX(line.textStart())) <= 1);
    }
    const QString plain = view.document()->toPlainText();
    for (int other : {1280, 640, width}) { view.resize(other, 900); QCoreApplication::processEvents(); view.relayout(); }
    QCOMPARE(view.document()->toPlainText(), plain); QCOMPARE(draft(view, source), source);
    QVERIFY(view.pendingEdits().isEmpty()); QVERIFY(!view.document()->isUndoAvailable());
  }
  void automaticAndExplicitIndentHaveMatchingLineGeometry_data() {
    QTest::addColumn<int>("width");
    for (int width : {640, 820, 1280}) QTest::newRow(qPrintable(QString::number(width))) << width;
  }
  void automaticAndExplicitIndentHaveMatchingLineGeometry() {
    QFETCH(int, width);
    const QString payload = QStringLiteral("中文段落首行应当对齐，续行回到正文左侧。English words与数字2026、标点（括号）共同检查折行位置。").repeated(14);
    const QString prefix = QString(QChar(0x3000)).repeated(2);
    DocumentView automatic, explicitSpaces;
    load(automatic, payload + "\n", width); load(explicitSpaces, prefix + payload + "\n", width);
    const auto a = automatic.document()->find(QStringLiteral("中文段落")).block();
    const auto b = explicitSpaces.document()->find(QStringLiteral("中文段落")).block();
    reportLines(a, "automatic-indent-pair"); reportLines(b, "explicit-indent-pair");
    QCOMPARE(a.layout()->lineCount(), b.layout()->lineCount()); QVERIFY(a.layout()->lineCount() > 1);
    for (int i = 0; i < a.layout()->lineCount(); ++i) {
      const auto al = a.layout()->lineAt(i), bl = b.layout()->lineAt(i);
      const int aStart = al.textStart(), bStart = i == 0 ? 2 : bl.textStart();
      const qreal ax = automatic.contentLeft() + automatic.document()->documentLayout()->blockBoundingRect(a).left() + al.cursorToX(aStart);
      const qreal bx = explicitSpaces.contentLeft() + explicitSpaces.document()->documentLayout()->blockBoundingRect(b).left() + bl.cursorToX(bStart);
      qInfo() << "paired-line" << width << i << "first-visible-character-x" << ax << bx;
      QVERIFY(qAbs(ax - bx) <= 1);
      if (i > 0) QCOMPARE(aStart, bl.textStart() - 2);
      QCOMPARE(al.textStart() + al.textLength(), bl.textStart() + bl.textLength() - 2);
    }
    QCOMPARE(a.text(), payload); QCOMPARE(b.text(), prefix + payload);
    QCOMPARE(draft(automatic, payload + "\n"), payload + "\n");
    QCOMPARE(draft(explicitSpaces, prefix + payload + "\n"), prefix + payload + "\n");
    QVERIFY(!automatic.document()->isUndoAvailable()); QVERIFY(!explicitSpaces.document()->isUndoAvailable());
  }
  void automaticIndentIsLimitedToEligibleRootParagraphs() {
    const QString source = QStringLiteral("普通中文正文\n\n  原始空格中文\n\n&#32;&#32;实体空格中文\n\n　　全角空格中文\n\n# 中文标题\n\n- 中文列表\n\n> 中文引用\n\n```text\n中文代码\n```\n\n| 中文表头 |\n| --- |\n| 中文单元格 |\n\nPlain English paragraph\n");
    DocumentView view; load(view, source);
    const qreal expected = QFontMetricsF(theme::uiFont(16)).horizontalAdvance(QString(QChar(0x3000)).repeated(2));
    const auto ordinary = view.document()->find(QStringLiteral("普通中文正文")).block();
    QVERIFY(qAbs(ordinary.blockFormat().textIndent() - expected) <= 0.1);
    const auto syntaxSpaces = view.document()->find(QStringLiteral("原始空格中文")).block();
    QVERIFY(syntaxSpaces.text().startsWith(QStringLiteral("原始空格中文")));
    QVERIFY(qAbs(syntaxSpaces.blockFormat().textIndent() - expected) <= 0.1);
    for (const QString label : {QStringLiteral("实体空格中文"), QStringLiteral("全角空格中文"),
        QStringLiteral("中文标题"), QStringLiteral("中文引用"), QStringLiteral("中文代码"), QStringLiteral("中文表头"),
        QStringLiteral("中文单元格"), QStringLiteral("Plain English paragraph")}) {
      const auto cursor = view.document()->find(label); QVERIFY2(!cursor.isNull(), qPrintable(label));
      qInfo() << "excluded-indent" << label << cursor.blockFormat().textIndent();
      QCOMPARE(cursor.blockFormat().textIndent(), qreal(0));
    }
    const auto list = view.document()->find(QStringLiteral("中文列表")); QVERIFY(!list.isNull());
    QVERIFY(list.blockFormat().textIndent() <= 0); // native marker's hanging indent remains legitimate
    QCOMPARE(draft(view, source), source); QVERIFY(!view.document()->isUndoAvailable());
  }
  void leadingSpaceEditSaveAndSingleUndo_data() {
    QTest::addColumn<bool>("startsWithSpaces");
    QTest::newRow("add-explicit-leading-spaces") << false;
    QTest::newRow("remove-explicit-leading-spaces") << true;
  }
  void leadingSpaceEditSaveAndSingleUndo() {
    QFETCH(bool, startsWithSpaces);
    const QString prefix = QString(QChar(0x3000)).repeated(2);
    const QString body = QStringLiteral("中文正文首行缩进只影响显示，不能进入保存数据。\n\n后续段落。\n");
    const QString original = (startsWithSpaces ? prefix : QString()) + body;
    const QString expectedEdited = (startsWithSpaces ? QString() : prefix) + body;
    QTemporaryDir directory; QVERIFY(directory.isValid()); const QString path = directory.filePath("copy.md");
    QFile file(path); QVERIFY(file.open(QIODevice::WriteOnly)); file.write(original.toUtf8()); file.close();
    const auto opened = bridge::openDocument(path); QVERIFY(opened.value("ok").toBool());
    const QString canonicalPath = opened.value("document").toObject().value("path").toString(); QVERIFY(!canonicalPath.isEmpty());
    DocumentView view; load(view, original);
    QVERIFY(bridge::saveDocument(canonicalPath, draft(view, original), {}).value("ok").toBool()); QCOMPARE(bytes(path), original.toUtf8());
    const auto block = view.document()->find(QStringLiteral("中文正文")).block(); QVERIFY(block.isValid());
    const qreal automaticIndent = QFontMetricsF(theme::uiFont(16)).horizontalAdvance(prefix);
    const qreal initialIndent = startsWithSpaces ? 0 : automaticIndent;
    QVERIFY(qAbs(block.blockFormat().textIndent() - initialIndent) <= 0.1);
    view.cursor_ = QTextCursor(block); view.setFocus(); view.ensureCaretVisible();
    if (startsWithSpaces) {
      view.cursor_.setPosition(block.position() + 2, QTextCursor::KeepAnchor);
      QTest::keyClick(&view, Qt::Key_Backspace);
    } else {
      QInputMethodEvent input; input.setCommitString(prefix); QApplication::sendEvent(&view, &input);
    }
    QCoreApplication::processEvents(); view.relayout();
    const auto editedBlock = view.document()->find(QStringLiteral("中文正文")).block();
    qInfo() << "after-leading-space-edit-indent" << editedBlock.blockFormat().textIndent();
    QVERIFY(qAbs(editedBlock.blockFormat().textIndent() - (startsWithSpaces ? automaticIndent : 0)) <= 0.1);
    QCOMPARE(draft(view, original), expectedEdited);
    QVERIFY(bridge::saveDocument(canonicalPath, draft(view, original), {}).value("ok").toBool()); QCOMPARE(bytes(path), expectedEdited.toUtf8());
    QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier); QCoreApplication::processEvents(); view.relayout();
    QCOMPARE(draft(view, original), original);
    const auto restored = view.document()->find(QStringLiteral("中文正文")).block();
    QVERIFY(qAbs(restored.blockFormat().textIndent() - initialIndent) <= 0.1);
    QVERIFY(bridge::saveDocument(canonicalPath, draft(view, original), {}).value("ok").toBool()); QCOMPARE(bytes(path), original.toUtf8());
    QVERIFY(view.document()->isRedoAvailable());
    QTest::keyClick(&view, Qt::Key_Y, Qt::ControlModifier); QCoreApplication::processEvents(); view.relayout();
    QCOMPARE(draft(view, original), expectedEdited);
    const auto redone = view.document()->find(QStringLiteral("中文正文")).block();
    QVERIFY(qAbs(redone.blockFormat().textIndent() - (startsWithSpaces ? automaticIndent : 0)) <= 0.1);
    QVERIFY(bridge::saveDocument(canonicalPath, draft(view, original), {}).value("ok").toBool()); QCOMPARE(bytes(path), expectedEdited.toUtf8());
    QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier); QCoreApplication::processEvents(); view.relayout();
    QCOMPARE(draft(view, original), original);
    QVERIFY(qAbs(view.document()->find(QStringLiteral("中文正文")).blockFormat().textIndent() - initialIndent) <= 0.1);
    QVERIFY(bridge::saveDocument(canonicalPath, draft(view, original), {}).value("ok").toBool()); QCOMPARE(bytes(path), original.toUtf8());
  }
  void quoteToggleAndReopenPreserveIndentSemantics_data() {
    QTest::addColumn<bool>("explicitSpaces");
    QTest::newRow("automatic-indent") << false;
    QTest::newRow("explicit-fullwidth-spaces") << true;
  }
  void quoteToggleAndReopenPreserveIndentSemantics() {
    QFETCH(bool, explicitSpaces);
    const QString prefix = QString(QChar(0x3000)).repeated(2);
    const QString text = (explicitSpaces ? prefix : QString()) + QStringLiteral("中文引用切换保留文字。");
    const QString original = text + "\n";
    const qreal ordinaryIndent = explicitSpaces ? 0 : QFontMetricsF(theme::uiFont(16)).horizontalAdvance(prefix);
    QTemporaryDir directory; QVERIFY(directory.isValid()); const QString path = directory.filePath("quote.md");
    QFile file(path); QVERIFY(file.open(QIODevice::WriteOnly)); file.write(original.toUtf8()); file.close();
    const auto opened = bridge::openDocument(path); QVERIFY(opened.value("ok").toBool());
    const QString canonicalPath = opened.value("document").toObject().value("path").toString(); QVERIFY(!canonicalPath.isEmpty());
    DocumentView view; load(view, original);
    QVERIFY(view.revealText(QStringLiteral("中文引用"))); view.setFocus();
    QVERIFY(qAbs(view.cursor_.blockFormat().textIndent() - ordinaryIndent) <= 0.1);
    QTest::keyClick(&view, Qt::Key_B, Qt::ControlModifier | Qt::ShiftModifier);
    QCoreApplication::processEvents(); view.relayout();
    const auto quotedBlock = view.document()->find(QStringLiteral("中文引用")).block();
    QCOMPARE(quotedBlock.blockFormat().textIndent(), qreal(0)); QCOMPARE(quotedBlock.text(), text);
    QVERIFY(quotedBlock.blockFormat().intProperty(QTextFormat::UserProperty + 23) > 0);
    const QString quoted = draft(view, original);
    QVERIFY(quoted.startsWith("> ")); QVERIFY(quoted.contains(text));
    QVERIFY(bridge::saveDocument(canonicalPath, quoted, {}).value("ok").toBool()); QCOMPARE(bytes(path), quoted.toUtf8());
    const auto reopened = bridge::openDocument(path); QVERIFY(reopened.value("ok").toBool());
    const QString reopenedPath = reopened.value("document").toObject().value("path").toString(); QVERIFY(!reopenedPath.isEmpty());
    DocumentView fresh; load(fresh, QString::fromUtf8(bytes(path)));
    const auto reopenedBlock = fresh.document()->find(QStringLiteral("中文引用")).block();
    QCOMPARE(reopenedBlock.blockFormat().textIndent(), qreal(0)); QCOMPARE(reopenedBlock.text(), text);
    QCOMPARE(reopenedBlock.blockFormat().leftMargin(), quotedBlock.blockFormat().leftMargin());
    QVERIFY(fresh.revealText(QStringLiteral("中文引用"))); fresh.setFocus();
    QTest::keyClick(&fresh, Qt::Key_B, Qt::ControlModifier | Qt::ShiftModifier);
    QCoreApplication::processEvents(); fresh.relayout();
    const auto ordinary = fresh.document()->find(QStringLiteral("中文引用")).block();
    QCOMPARE(ordinary.text(), text); QVERIFY(qAbs(ordinary.blockFormat().textIndent() - ordinaryIndent) <= 0.1);
    QCOMPARE(ordinary.blockFormat().intProperty(QTextFormat::UserProperty + 23), 0);
    QCOMPARE(draft(fresh, quoted), original);
    QVERIFY(bridge::saveDocument(reopenedPath, draft(fresh, quoted), {}).value("ok").toBool()); QCOMPARE(bytes(path), original.toUtf8());
  }
  void sourceWhitespaceAndBreakSemantics() {
    const QString source = QStringLiteral("  ASCII前导\n继续\n\n　　全角前导\n继续\n\n&#32;&#32;实体空格\n继续\n\n软行甲\n软行乙  \n硬行丙\n\n下一段\n");
    DocumentView view; load(view, source);
    const auto ascii = view.document()->find(QStringLiteral("ASCII前导")).block();
    const auto ideographic = view.document()->find(QStringLiteral("全角前导")).block();
    const auto entity = view.document()->find(QStringLiteral("实体空格")).block();
    QVERIFY(ascii.text().startsWith("ASCII"));
    QVERIFY(ideographic.text().startsWith(QString(QChar(0x3000)).repeated(2)));
    QVERIFY(entity.text().startsWith("  "));
    const auto lines = view.document()->find(QStringLiteral("软行甲")).block();
    reportLines(lines, "explicit-soft-and-hard-breaks");
    QCOMPARE(lines.text().count(QChar::LineSeparator), 2); QCOMPARE(lines.layout()->lineCount(), 3);
    int soft = 0, hard = 0;
    for (auto it = lines.begin(); !it.atEnd(); ++it) {
      const auto fragment = it.fragment();
      if (fragment.text().contains(QChar::LineSeparator)) {
        // Display's SoftBreakProperty preserves the Markdown distinction on export.
        if (fragment.charFormat().boolProperty(QTextFormat::UserProperty + 11)) ++soft; else ++hard;
      }
    }
    QCOMPARE(soft, 1); QCOMPARE(hard, 1);
    const auto next = view.document()->find(QStringLiteral("下一段")).block();
    QVERIFY(next != lines); qInfo() << "next-paragraph-gap" <<
        view.document()->documentLayout()->blockBoundingRect(next).top() - view.document()->documentLayout()->blockBoundingRect(lines).bottom();
    QCOMPARE(draft(view, source), source); QVERIFY(!view.document()->isUndoAvailable());
  }
  void editSaveUndoPreservesChineseSourceBytes() {
    const QString source = QString(QChar(0xfeff)) + QStringLiteral("　　中文首行\r\n软换行  \r\n硬换行\r\n\r\n末尾目标\r\n");
    QTemporaryDir directory; QVERIFY(directory.isValid()); const QString path = directory.filePath("copy.md");
    QFile file(path); QVERIFY(file.open(QIODevice::WriteOnly)); QCOMPARE(file.write(source.toUtf8()), qint64(source.toUtf8().size())); file.close();
    const auto opened = bridge::openDocument(path); QVERIFY(opened.value("ok").toBool());
    const QString canonicalPath = opened.value("document").toObject().value("path").toString(); QVERIFY(!canonicalPath.isEmpty());
    DocumentView view; load(view, source);
    QVERIFY(bridge::saveDocument(canonicalPath, draft(view, source), {}).value("ok").toBool()); QCOMPARE(bytes(path), source.toUtf8());
    QVERIFY(view.revealText(QStringLiteral("末尾目标"))); view.setFocus();
    QTest::keyClick(&view, Qt::Key_Right); QTest::keyClicks(&view, "X");
    const QString edited = draft(view, source);
    QCOMPARE(edited, QString(source).replace(QStringLiteral("末尾目标"), QStringLiteral("末尾目标X")));
    QVERIFY(bridge::saveDocument(canonicalPath, edited, {}).value("ok").toBool()); QCOMPARE(bytes(path), edited.toUtf8());
    QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier); QCOMPARE(draft(view, source), source);
    QVERIFY(bridge::saveDocument(canonicalPath, draft(view, source), {}).value("ok").toBool()); QCOMPARE(bytes(path), source.toUtf8());
  }
  void taskPreviewRetainsInlineCodeStyling() {
    const QString source = QStringLiteral("- [ ] 按 `Ctrl+F` 查找\n- [ ] 按 `Ctrl+S` 保存\n");
    DocumentView view; load(view, source); QVERIFY(view.rawSurfaces_.isEmpty());
    view.relayout();
    const auto code = view.document()->find("Ctrl+F"); QVERIFY(!code.isNull());
    qInfo() << "task-code-family/size/property/pill-count" << code.charFormat().fontFamilies()
            << code.charFormat().font().pixelSize() << code.charFormat().boolProperty(QTextFormat::UserProperty + 2)
            << view.inlineBoxes_.size();
    QVERIFY(code.charFormat().boolProperty(QTextFormat::UserProperty + 2));
    QCOMPARE(code.charFormat().font().pixelSize(), 14);
    QVERIFY(!view.inlineBoxes_.isEmpty());
    for (const auto& box : view.inlineBoxes_) QVERIFY(box.rect.width() > 0 && box.rect.height() > 0);
    const auto second = view.document()->find("Ctrl+S"); QVERIFY(!second.isNull());
    const auto firstRect = view.document()->documentLayout()->blockBoundingRect(code.block());
    const auto secondRect = view.document()->documentLayout()->blockBoundingRect(second.block());
    QCOMPARE(secondRect.top() - firstRect.top(), 32.0);
    QVERIFY(firstRect.bottom() <= secondRect.top());
    QCOMPARE(draft(view, source), source); QVERIFY(view.pendingEdits().isEmpty());
  }
  void nestedQuotesHaveDistinctRules() {
    const QString source = "> outer\n>\n>> middle\n>>\n>>> inner\n";
    DocumentView view; load(view, source); QVector<qreal> lefts;
    for (const auto& bar : view.quoteBars_) {
      qInfo() << "quote-rule" << bar.rect;
      bool found = false; for (qreal x : lefts) if (qAbs(x - bar.rect.left()) < 0.1) found = true;
      if (!found) lefts.append(bar.rect.left());
    }
    std::sort(lefts.begin(), lefts.end());
    QVERIFY2(lefts.size() >= 3, "Three quote depths need three distinct rule x coordinates");
    QCOMPARE(draft(view, source), source); QVERIFY(!view.document()->isUndoAvailable());
  }
  void codeLineBoxesReportAndPreserveData() {
    const QString source = "```ts\ntype Value = {\n  count: number;\n};\n\nconsole.log(1);\n```\n\n```text\n" + QString("long_").repeated(100) + "\n```\n";
    DocumentView view; load(view, source);
    const auto code = view.document()->find("type Value").block(); QVERIFY(code.isValid()); reportLines(code, "multiline-code-including-empty-line");
    for (const auto& box : view.codeBoxes_) qInfo() << "code-surface" << box.rect;
    for (const auto& region : view.horizontalRegions_) qInfo() << "code-scroll-region/max" << region.rect << region.maximum;
    QCOMPARE(code.layout()->lineCount(), 5);
    for (int i = 1; i < code.layout()->lineCount(); ++i)
      QVERIFY2(qAbs(code.layout()->lineAt(i).y() - code.layout()->lineAt(i - 1).y() - 25.6) < 0.2,
               "Measured legacy code baseline interval is 25.6px, including blank lines");
    const auto longLine = view.document()->find("long_").block(); QCOMPARE(longLine.layout()->lineCount(), 1);
    // Surface heights are diagnostic until matched baseline geometry is confirmed.
    QCOMPARE(draft(view, source), source); QVERIFY(view.pendingEdits().isEmpty()); QVERIFY(!view.document()->isUndoAvailable());
  }
};
QTEST_MAIN(BodyLayoutRegressions)
#include "body_layout_regressions.moc"
