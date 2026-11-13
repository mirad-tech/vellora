#include <QtWidgets>
#include <QtTest>
#include <algorithm>
#include "bridge.h"
#include "document_view.h"

class FidelityRegressions : public QObject {
  Q_OBJECT
  static void load(DocumentView& v, const QString& source) {
    v.resize(820,900); v.show(); v.setFocus();
    v.setPlan(bridge::planFor(source).value("plan").toObject(),{});
    v.setPreviewContext(source); QCoreApplication::processEvents(); v.relayout();
  }
  static QString save(DocumentView& v,const QString& source) {
    QJsonArray edits; for(const auto& e:v.pendingEdits()) edits.append(QJsonObject{{"index",e.first},{"markdown",e.second}});
    const auto result=bridge::spliceSegments(source,edits);
    return result.value("ok").toBool()?result.value("content").toString():QString();
  }
  static void commit(DocumentView& v,const QString& text) {
    QInputMethodEvent e; e.setCommitString(text); QApplication::sendEvent(&v,&e); QCoreApplication::processEvents();
  }
  static bool appendAfter(DocumentView& v,const QString& text,const QString& addition="!") {
    if(!v.revealText(text))return false; QTest::keyClick(&v,Qt::Key_Right); commit(v,addition); return true;
  }
  static QJsonArray blocks(const QString& source) { return bridge::planFor(source).value("plan").toObject().value("blocks").toArray(); }
  static QString visibleText(DocumentView& v) {
    QString out; for(auto b=v.document()->begin();b.isValid();b=b.next())if(b.isVisible())out+=b.text()+"\n";return out.replace(QChar::LineSeparator, QLatin1Char('\n'));
  }
  static QList<qreal> quoteXs(DocumentView& v) {
    v.relayout(); QList<qreal> values; for(const auto& q:v.quoteBars_)if(std::none_of(values.cbegin(),values.cend(),[&](qreal x){return qAbs(x-q.rect.x())<0.1;}))values.append(q.rect.x());std::sort(values.begin(),values.end());return values;
  }
 private slots:
  void emptyItemSiblingEdit_data() {
    QTest::addColumn<QString>("source");
    QTest::newRow("ordered")<<QString("1. alpha\n2.\n3. gamma\n");
    QTest::newRow("unordered")<<QString("- alpha\n-\n- gamma\n");
    QTest::newRow("ordered-parenthesis")<<QString("7) alpha\n8)\n9) gamma\n");
  }
  void emptyItemSiblingEdit() {
    QFETCH(QString,source); DocumentView v;load(v,source);
    int visible=0;for(auto b=v.document()->begin();b.isValid();b=b.next())if(b.isVisible()&&!b.text().isEmpty())++visible;
    QVERIFY2(visible>=3,qPrintable(visibleText(v)));
    QVERIFY(appendAfter(v,"alpha"));const QString saved=save(v,source);QVERIFY(!saved.isEmpty());
    const auto items=blocks(saved).first().toObject().value("items").toArray();QCOMPARE(items.size(),3);
    QVERIFY(saved.contains("alpha!"));QVERIFY(saved.contains("gamma"));QVERIFY(!saved.contains("&nbsp;"));
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
    QTest::keyClick(&v,Qt::Key_Y,Qt::ControlModifier);QCOMPARE(blocks(save(v,source)).first().toObject().value("items").toArray().size(),3);
    DocumentView reopened;load(reopened,saved);QVERIFY(visibleText(reopened).contains("gamma"));QCOMPARE(save(reopened,saved),saved);
  }
  void emptyItemAcceptsTextAndUndo() {
    const QString source="1. alpha\n2.\n3. gamma\n";DocumentView v;load(v,source);QTextBlock empty;
    for(auto b=v.document()->begin();b.isValid();b=b.next())if(b.isVisible()&&b.text().trimmed()=="2."){empty=b;break;}
    QVERIFY2(empty.isValid(),qPrintable(visibleText(v)));v.restoreSelectionState({empty.position()+empty.length()-1,empty.position()+empty.length()-1});commit(v,QStringLiteral("中文空项"));const QString saved=save(v,source);QVERIFY2(saved.contains(QStringLiteral("2. 中文空项")),qPrintable(saved));QCOMPARE(blocks(saved).first().toObject().value("items").toArray().size(),3);QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void imageAltNeighborEdit_data() {
    QTest::addColumn<QString>("alt");
    QTest::newRow("bold")<<QStringLiteral("前缀 **重要文字** 后缀");
    QTest::newRow("italic")<<QStringLiteral("前缀 *重要文字* 后缀");
    QTest::newRow("strike")<<QStringLiteral("前缀 ~~重要文字~~ 后缀");
    QTest::newRow("code")<<QStringLiteral("前缀 `code * literal` 后缀");
    QTest::newRow("escaped")<<QStringLiteral("前缀 \\*literal\\* \\[label\\] 后缀");
    QTest::newRow("nested")<<QStringLiteral("前缀 **粗体 *斜体*** 后缀");
  }
  void imageAltNeighborEdit() {
    QFETCH(QString,alt);const QString image="!["+alt+"](missing.png)";const QString source="prefix "+image+" tail\n";
    DocumentView v;load(v,source);QVERIFY(appendAfter(v,"tail"));const QString saved=save(v,source);QVERIFY2(saved.contains(image),qPrintable(saved));QVERIFY(saved.contains("tail!"));
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void referenceImageNeighborEdit_data() {
    QTest::addColumn<QString>("image"); QTest::addColumn<QString>("definition");
    QTest::newRow("image-full") << QString("![alt][pic]") << QString("[pic]: missing.png \"title\"");
    QTest::newRow("image-collapsed") << QString("![picture][]") << QString("[picture]: missing.png");
    QTest::newRow("image-shortcut") << QString("![picture]") << QString("[picture]: missing.png");
    QTest::newRow("image-marked-alt") << QString("![**important** alt][pic]") << QString("[pic]: missing.png");
  }
  void referenceImageNeighborEdit() {
    QFETCH(QString,image);QFETCH(QString,definition);const QString source="prefix "+image+" tail\n\n"+definition+"\n";
    QCOMPARE(blocks(source).first().toObject().value("type").toString(),QString("paragraph"));
    DocumentView v;load(v,source);QVERIFY(v.rawSurfaces_.isEmpty());QVERIFY(appendAfter(v,"tail"));const QString saved=save(v,source);
    QVERIFY2(saved.contains(image),qPrintable(saved));QVERIFY(saved.endsWith(definition+"\n"));
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void referenceParagraphEditable_data() {
    QTest::addColumn<QString>("syntax");QTest::addColumn<QString>("definition");
    QTest::newRow("full")<<QStringLiteral("[链接][ref]")<<QString("[ref]: https://example.com/ \"title\"");
    QTest::newRow("collapsed")<<QStringLiteral("[链接][]")<<QStringLiteral("[链接]: https://example.com/ \"title\"");
    QTest::newRow("shortcut")<<QStringLiteral("[链接]")<<QStringLiteral("[链接]: https://example.com/ \"title\"");
    QTest::newRow("marked-label")<<QStringLiteral("[**粗体**和*斜体*][ref]")<<QString("[ref]: https://example.com/ \"title\"");
  }
  void referenceParagraphEditable() {
    QFETCH(QString,syntax);QFETCH(QString,definition);const QString source=QStringLiteral("中文前文 ")+syntax+QStringLiteral(" 结尾。\n\n")+definition+"\n";
    QCOMPARE(blocks(source).first().toObject().value("type").toString(),QString("paragraph"));
    DocumentView v;load(v,source);QVERIFY(v.rawSurfaces_.isEmpty());const auto first=v.document()->find(QStringLiteral("中文前文")).block();QVERIFY(first.isValid());QVERIFY(first.blockFormat().textIndent()>20);
    QVERIFY(appendAfter(v,QStringLiteral("结尾。")));const QString saved=save(v,source);QVERIFY2(saved.contains(syntax),qPrintable(saved));QVERIFY(saved.endsWith(definition+"\n"));
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void adjacentSameUrlReferencesStayDistinct() {
    const QString source="before [one][a][two][b] tail\n\n[a]: https://example.com/\n[b]: https://example.com/\n";DocumentView v;load(v,source);QVERIFY(appendAfter(v,"tail"));const QString saved=save(v,source);QVERIFY2(saved.contains("[one][a][two][b]"),qPrintable(saved));
  }
  void referenceLabelEditKeepsTarget() {
    const QString source="before [label][] tail\n\n[label]: https://example.com/\n";DocumentView v;load(v,source);QVERIFY(v.revealText("label"));commit(v,"changed");const QString saved=save(v,source);QVERIFY2(saved.contains("[changed][label]"),qPrintable(saved));
  }
  void emptyDestinationReferenceKeepsAnchor() {
    const QString source="before [label][r] tail\n\n[r]: <>\n";DocumentView v;load(v,source);QVERIFY(appendAfter(v,"tail"));const QString saved=save(v,source);QVERIFY2(saved.contains("[label][r]"),qPrintable(saved));
  }
  void sameReferenceOccurrencesDoNotMerge() {
    const QString source="before [same][r][same][r] tail\n\n[r]: https://example.com/\n";DocumentView v;load(v,source);QVERIFY(appendAfter(v,"tail"));const QString saved=save(v,source);QVERIFY2(saved.contains("[same][r][same][r]"),qPrintable(saved));
  }
  void nestedReferenceMarksSurviveNeighborEdit_data() {
    QTest::addColumn<QString>("label");QTest::newRow("bold-italic")<<QString("**bold *nested***");QTest::newRow("italic-bold")<<QString("*italic **nested***");QTest::newRow("strike-bold")<<QString("~~strike **nested**~~");
  }
  void nestedReferenceMarksSurviveNeighborEdit() {
    QFETCH(QString,label);const QString source="before ["+label+"][r] tail\n\n[r]: https://example.com/\n";
    auto linkedCharacters=[](const QString& md){QJsonArray chars;for(const auto& value:blocks(md).first().toObject().value("runs").toArray()){const auto run=value.toObject();if(run.value("link").isNull())continue;for(QChar ch:run.value("text").toString())chars.append(QJsonObject{{"text",QString(ch)},{"bold",run.value("bold")},{"italic",run.value("italic")},{"strike",run.value("strike")},{"href",run.value("link").toObject().value("href")}});}return chars;};
    DocumentView v;load(v,source);QVERIFY(appendAfter(v,"tail"));const QString saved=save(v,source);QVERIFY2(linkedCharacters(saved)==linkedCharacters(source),qPrintable(saved));
  }
  void referenceReplacementBoundaries_data() {
    QTest::addColumn<QString>("source");QTest::addColumn<QString>("selected");QTest::addColumn<QString>("expected");
    QTest::newRow("plain-and-link")<<QString("before [label][r] tail\n\n[r]: https://example.com/\n")<<QString("before label")<<QString("replacement tail\n\n[r]: https://example.com/\n");
    QTest::newRow("different-occurrences")<<QString("[one][a][two][b] tail\n\n[a]: https://example.com/\n[b]: https://example.com/\n")<<QString("onetwo")<<QString("replacement tail\n\n[a]: https://example.com/\n[b]: https://example.com/\n");
    QTest::newRow("single-mixed-style")<<QString("before [**bold** plain][r] tail\n\n[r]: https://example.com/\n")<<QString("bold plain")<<QString("before [replacement][r] tail\n\n[r]: https://example.com/\n");
  }
  void referenceReplacementBoundaries() {
    QFETCH(QString,source);QFETCH(QString,selected);QFETCH(QString,expected);DocumentView v;load(v,source);QVERIFY(v.revealText(selected));commit(v,"replacement");QCOMPARE(save(v,source),expected);QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void deletingEmptyItemDoesNotResurrectIt() {
    const QString source="1. alpha\n2.\n3. gamma\n";DocumentView v;load(v,source);QTextBlock empty;
    for(auto b=v.document()->begin();b.isValid();b=b.next())if(b.isVisible()&&b.text().trimmed()=="2."){empty=b;break;}
    QVERIFY(empty.isValid());QVERIFY(empty.next().isValid());v.restoreSelectionState({empty.position(),empty.next().position()});QTest::keyClick(&v,Qt::Key_Delete);const QString saved=save(v,source);
    QVERIFY2(!saved.isEmpty(),qPrintable(saved));QCOMPARE(blocks(saved).first().toObject().value("items").toArray().size(),2);QVERIFY(saved.contains("alpha"));QVERIFY(saved.contains("gamma"));
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);QTest::keyClick(&v,Qt::Key_Y,Qt::ControlModifier);QCOMPARE(save(v,source),saved);
    DocumentView reopened;load(reopened,saved);QCOMPARE(save(reopened,saved),saved);
  }
  void referenceImeCommitAndUndo() {
    const QString source=QStringLiteral("中文 [链接][r] 尾部\n\n[r]: https://example.com/\n");DocumentView v;load(v,source);QVERIFY(v.revealText(QStringLiteral("尾部")));QTest::keyClick(&v,Qt::Key_Right);
    QInputMethodEvent preedit(QStringLiteral("zhong"),{});QApplication::sendEvent(&v,&preedit);QVERIFY(v.isComposing());QCOMPARE(save(v,source),source);commit(v,QStringLiteral("中文"));QVERIFY(!v.isComposing());QVERIFY(save(v,source).contains(QStringLiteral("尾部中文")));QVERIFY(save(v,source).contains(QStringLiteral("[链接][r]")));QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void hiddenRawPreserved_data() {
    QTest::addColumn<QString>("hidden");
    QTest::newRow("definition")<<QString("[ref]: https://example.com/ \"title\"");
    QTest::newRow("comment")<<QString("<!-- private note -->");
    QTest::newRow("multiline-comment")<<QString("<!-- one\n two -->");
  }
  void hiddenRawPreserved() {
    QFETCH(QString,hidden);const QString source="before\n\n"+hidden+"\n\nafter\n";DocumentView v;load(v,source);QVERIFY2(!visibleText(v).contains(hidden),qPrintable(visibleText(v)));QCOMPARE(save(v,source),source);
    QVERIFY(appendAfter(v,"after"));const QString saved=save(v,source);QVERIFY(saved.contains(hidden));QVERIFY(saved.contains("after!"));QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void hiddenRawHasNoLayoutGap() {
    DocumentView v,control;load(v,"before\n\n<!-- hidden -->\n\nafter\n");load(control,"before\n\nafter\n");
    auto gap=[](DocumentView& d){const auto a=d.document()->find("before").block(),b=d.document()->find("after").block();return d.document()->documentLayout()->blockBoundingRect(b).top()-d.document()->documentLayout()->blockBoundingRect(a).bottom();};
    QVERIFY(qAbs(gap(v)-gap(control))<1);
  }
  void hiddenOnlyCanAcceptTextWithoutLoss() {
    const QString source="<!-- retained -->\n";DocumentView v;load(v,source);commit(v,QStringLiteral("正文"));const QString saved=save(v,source);QVERIFY2(saved.contains("<!-- retained -->"),qPrintable(saved));QVERIFY2(saved.contains(QStringLiteral("正文")),qPrintable(saved));QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void unknownRawRemainsAccessible() {
    const QString source="---\ncustom: preserved\n---\n\nbody\n";DocumentView v;load(v,source);QVERIFY(!blocks(source).first().toObject().value("hidden").toBool());QVERIFY(v.revealText("custom: preserved"));QVERIFY(visibleText(v).contains("custom: preserved"));QCOMPARE(save(v,source),source);
  }
  void nestedQuoteEnterKeepsAncestorOrder_data() {
    QTest::addColumn<QString>("source");
    QTest::newRow("list-quote")<<QString("- > quote\n");
    QTest::newRow("quote-list")<<QString("> - quote\n");
    QTest::newRow("list-double-quote")<<QString("- > > quote\n");
    QTest::newRow("quote-list-quote")<<QString("> - > quote\n");
  }
  void nestedQuoteEnterKeepsAncestorOrder() {
    QFETCH(QString,source);
    auto path=[](QJsonObject node){QStringList chain;for(int i=0;i<12;++i){const QString type=node.value("type").toString();chain.append(type);if(type=="quote"){node=node.value("blocks").toArray().first().toObject();}else if(type=="list"){node=node.value("items").toArray().first().toArray().first().toObject();}else break;}return chain;};
    DocumentView v;load(v,source);QVERIFY(v.revealText("quote"));QTest::keyClick(&v,Qt::Key_Right);QTest::keyClick(&v,Qt::Key_Return);commit(v,"next");const QString saved=save(v,source);QVERIFY2(saved.contains("quote")&&saved.contains("next"),qPrintable(saved));
    QCOMPARE(path(blocks(saved).first().toObject()),path(blocks(source).first().toObject()));
    for(int i=0;i<4&&save(v,source)!=source&&v.document()->isUndoAvailable();++i)QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void deepQuoteStructureChangesAreSafelyDeferred_data() {
    QTest::addColumn<QString>("action");for(const auto& action:QStringList{"enter","heading","list","quote","indent","multiline-paste","cross-block-delete"})QTest::newRow(qPrintable(action))<<action;
  }
  void deepQuoteStructureChangesAreSafelyDeferred() {
    QFETCH(QString,action);const QString source="- > > - [ ] task\n\nafter\n";DocumentView v;load(v,source);QVERIFY(v.revealText("task"));
    if(action=="cross-block-delete"){const auto a=v.document()->find("task"),b=v.document()->find("after");v.restoreSelectionState({a.selectionStart(),b.selectionEnd()});QTest::keyClick(&v,Qt::Key_Delete);}
    else if(action=="heading")QTest::keyClick(&v,Qt::Key_1,Qt::ControlModifier|Qt::AltModifier);
    else if(action=="list")QTest::keyClick(&v,Qt::Key_7,Qt::ControlModifier|Qt::ShiftModifier);
    else if(action=="quote")QTest::keyClick(&v,Qt::Key_B,Qt::ControlModifier|Qt::ShiftModifier);
    else {QTest::keyClick(&v,Qt::Key_Right);if(action=="enter")QTest::keyClick(&v,Qt::Key_Return);else if(action=="indent")QTest::keyClick(&v,Qt::Key_Tab);else {QApplication::clipboard()->setText("first\nsecond");QTest::keyClick(&v,Qt::Key_V,Qt::ControlModifier);}}
    QCOMPARE(save(v,source),source);QVERIFY(!QToolTip::text().isEmpty());QToolTip::hideText();
    QVERIFY(appendAfter(v,"task"));QVERIFY(save(v,source).contains("task!"));
  }
  void closeReleasesReferenceFingerprints() {
    DocumentView v;load(v,"[label][r]\n\n[r]: https://example.com/\n");QVERIFY(!v.originalReferenceFingerprints_.isEmpty());v.setEmptyState();QVERIFY(v.originalReferenceFingerprints_.isEmpty());QVERIFY(v.pendingEdits().isEmpty());
  }
  void referenceFormattingEditDoesNotReuseOriginalSource() {
    const QString source="before [label][r] tail\n\n[r]: https://example.com/\n";DocumentView v;load(v,source);QVERIFY(v.revealText("label"));QTest::keyClick(&v,Qt::Key_B,Qt::ControlModifier);QVERIFY2(save(v,source).contains("[**label**][r]"),qPrintable(save(v,source)));QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void deepQuoteTaskDirectEditRemainsStructured() {
    const QString source="- > > - [ ] task\n";DocumentView v;load(v,source);QVERIFY(appendAfter(v,"task"));
    const QString saved=save(v,source);QVERIFY2(saved.contains("task!"),qPrintable(saved));
    auto original=blocks(source).first().toObject(),actual=blocks(saved).first().toObject();
    for(int i=0;i<8;++i){QCOMPARE(actual.value("type"),original.value("type"));const QString type=original.value("type").toString();if(type=="quote"){actual=actual.value("blocks").toArray().first().toObject();original=original.value("blocks").toArray().first().toObject();}else if(type=="list"){actual=actual.value("items").toArray().first().toArray().first().toObject();original=original.value("items").toArray().first().toArray().first().toObject();}else break;}
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(save(v,source),source);
  }
  void nestedQuoteBarsRespectAncestorOrder_data() {
    QTest::addColumn<QString>("source");QTest::addColumn<qreal>("base");
    QTest::newRow("quote-then-list")<<QString("> outer\n>\n> > inner\n> >\n> > - [ ] task\n> > - [x] done\n>\n> end\n")<<qreal(0);
    QTest::newRow("list-then-quote")<<QString("- > outer\n  >\n  > > inner\n  > >\n  > > - [ ] task\n  > > - [x] done\n")<<qreal(24);
  }
  void nestedQuoteBarsRespectAncestorOrder() {
    QFETCH(QString,source);QFETCH(qreal,base);DocumentView v;load(v,source);const auto xs=quoteXs(v);QCOMPARE(xs.size(),2);QVERIFY2(qAbs(xs.at(0)-base)<0.1,qPrintable(QString::number(xs.at(0))));QVERIFY(qAbs(xs.at(1)-(base+18))<0.1);QCOMPARE(save(v,source),source);
  }
};
QTEST_MAIN(FidelityRegressions)
#include "fidelity_regressions.moc"