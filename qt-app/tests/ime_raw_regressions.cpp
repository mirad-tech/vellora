#include <QtWidgets>
#include <QtTest>
#include <QTextLayout>
#include <QInputMethodEvent>
#include "bridge.h"
#include "document_view.h"
#include "theme.h"

class CapturingPreview : public DocumentView {
 public:
  explicit CapturingPreview(QWidget* parent):DocumentView(parent) {}
  QString written;
  int writes=0;
 protected:
  bool writeCodeClipboard(const QString& text) override {written=text;++writes;return true;}
};

class ImeRawRegressions : public QObject {
  Q_OBJECT
  static void load(DocumentView& view,const QString& text,int width=820) {
    view.resize(width,800);view.show();view.setPlan(bridge::planFor(text).value("plan").toObject(),{});
    view.setPreviewContext(text);QApplication::processEvents();view.relayout();view.setFocus();
  }
  static QString draft(DocumentView& view,const QString& source) {
    QJsonArray edits;for(const auto& e:view.pendingEdits())edits.append(QJsonObject{{"index",e.first},{"markdown",e.second}});
    return bridge::spliceSegments(source,edits).value("content").toString();
  }
  static void composing(DocumentView& view,const QString& text,int cursor) {
    QList<QInputMethodEvent::Attribute> attrs;
    attrs.append(QInputMethodEvent::Attribute(QInputMethodEvent::Cursor,cursor,1,QVariant()));
    QTextCharFormat underline;underline.setUnderlineStyle(QTextCharFormat::DashUnderline);
    attrs.append(QInputMethodEvent::Attribute(QInputMethodEvent::TextFormat,0,text.size(),underline));
    QInputMethodEvent event(text,attrs);QApplication::sendEvent(&view,&event);QApplication::processEvents();
    (void)view.document()->size();
  }
  static QPoint textPoint(DocumentView& view,const QString& text) {
    const auto found=view.document()->find(text);if(found.isNull())return {};
    const auto block=found.block();const int offset=found.selectionStart()-block.position();
    const auto line=block.layout()->lineForTextPosition(offset);
    const auto rect=view.document()->documentLayout()->blockBoundingRect(block);
    return QPoint(qRound(rect.left()+line.cursorToX(offset)+view.contentLeft()+2),
      qRound(rect.top()+line.y()+line.height()/2+view.topPadding()-view.scrollValue()));
  }
  static QString tasks() {
    QString result;for(int i=0;i<9;++i)result+=QString("- [ ] task %1\n").arg(i);
    return result+"\nFollowing paragraph\n";
  }
 private slots:
  void structuralImageFormatsReserveHeight_data() {
    QTest::addColumn<int>("key");QTest::addColumn<int>("mods");
    QTest::newRow("heading")<<int(Qt::Key_2)<<int(Qt::ControlModifier|Qt::AltModifier);
    QTest::newRow("body")<<int(Qt::Key_0)<<int(Qt::ControlModifier|Qt::AltModifier);
    QTest::newRow("list")<<int(Qt::Key_8)<<int(Qt::ControlModifier|Qt::ShiftModifier);
    QTest::newRow("quote")<<int(Qt::Key_B)<<int(Qt::ControlModifier|Qt::ShiftModifier);
  }
  void structuralImageFormatsReserveHeight() {
    QFETCH(int,key);QFETCH(int,mods);QTemporaryDir dir;QImage png(300,300,QImage::Format_ARGB32);png.fill(Qt::blue);QVERIFY(png.save(dir.filePath("sample.png")));
    const QString source="above\n\nprefix ![image](sample.png \"title\") suffix\n\nfollowing\n";
    DocumentView v;v.resize(822,932);v.show();v.setPlan(bridge::planFor(source).value("plan").toObject(),dir.filePath("sample.md"));v.setPreviewContext(source);QApplication::processEvents();
    auto b=v.document()->find("prefix").block();v.restoreSelectionState({b.position(),b.position()});
    QTest::keyClick(&v,Qt::Key(key),Qt::KeyboardModifiers(mods));QApplication::processEvents();
    QCOMPARE(b.blockFormat().lineHeightType(),int(QTextBlockFormat::MinimumHeight));QVERIFY(b.layout()->lineAt(0).y()>=-1);
    QVERIFY(draft(v,source).contains("![image](sample.png \"title\")"));
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(draft(v,source),source);
  }
  void imageParagraphToCodeKeepsMarkdownLiteral_data() {
    QTest::addColumn<QString>("source");
    QTest::newRow("single") << QString("prefix ![image](sample.png \"title\") suffix\n");
    QTest::newRow("adjacent") << QString("prefix ![image](sample.png \"title\")![image](sample.png \"title\") suffix\n");
    QTest::newRow("soft-break") << QString("prefix ![image](sample.png \"title\")\nnext line\n");
    QTest::newRow("linked") << QString("prefix [![image](sample.png \"title\")](https://example.com) suffix\n");
  }
  void imageParagraphToCodeKeepsMarkdownLiteral() {
    QTemporaryDir dir;QImage png(20,20,QImage::Format_ARGB32);png.fill(Qt::blue);QVERIFY(png.save(dir.filePath("sample.png")));
    QFETCH(QString,source);
    DocumentView v;v.resize(822,932);v.show();v.setPlan(bridge::planFor(source).value("plan").toObject(),dir.filePath("sample.md"));v.setPreviewContext(source);QApplication::processEvents();
    auto b=v.document()->find("prefix").block();v.restoreSelectionState({b.position(),b.position()});QTest::keyClick(&v,Qt::Key_C,Qt::ControlModifier|Qt::AltModifier);
    const QString saved=draft(v,source);QVERIFY2(saved.contains("![image](sample.png \"title\")"),qPrintable(saved));QVERIFY(!saved.contains(QChar::ObjectReplacementCharacter));QVERIFY2(saved.contains(source.trimmed()),qPrintable(saved));
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(draft(v,source),source);
  }
  void nestedTaskQuoteRoundTripKeepsDepth() {
    const QString source="- [ ] parent\n  - [x] child\n";DocumentView v;load(v,source);auto b=v.document()->find("child").block();v.restoreSelectionState({b.position()+3,b.position()+3});const qreal margin=b.blockFormat().leftMargin();
    QTest::keyClick(&v,Qt::Key_B,Qt::ControlModifier|Qt::ShiftModifier);QTest::keyClick(&v,Qt::Key_B,Qt::ControlModifier|Qt::ShiftModifier);
    QCOMPARE(b.blockFormat().leftMargin(),margin);QCOMPARE(draft(v,source),source);
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(draft(v,source),source);
  }
  void shiftedListKeyCodes_data() {
    QTest::addColumn<int>("key");QTest::addColumn<bool>("ordered");
    QTest::newRow("digit7")<<int(Qt::Key_7)<<true;QTest::newRow("ampersand")<<int(Qt::Key_Ampersand)<<true;
    QTest::newRow("digit8")<<int(Qt::Key_8)<<false;QTest::newRow("asterisk")<<int(Qt::Key_Asterisk)<<false;
  }
  void shiftedListKeyCodes() {
    QFETCH(int,key);QFETCH(bool,ordered);const QString source="plain item\n";DocumentView v;load(v,source);auto b=v.document()->find("plain").block();v.restoreSelectionState({b.position(),b.position()});
    QTest::keyClick(&v,Qt::Key(key),Qt::ControlModifier|Qt::ShiftModifier);QVERIFY(draft(v,source).startsWith(ordered?"1. plain":"- plain"));
    QTest::keyClick(&v,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(draft(v,source),source);
  }
  void searchOriginSelectionUsesCurrentHitColour() {
    const QString source="TOKEN TOKEN\n";DocumentView v;load(v,source);v.setSearchQuery("TOKEN",true);v.focusSearchResult(0);QApplication::processEvents();
    auto countColour=[&](QColor c){const QImage im=v.viewport()->grab().toImage();int n=0;for(int y=0;y<im.height();++y)for(int x=0;x<im.width();++x)if(im.pixelColor(x,y)==c)++n;return n;};
    QVERIFY(countColour(theme::accent())>20);const auto selection=v.selectionState();v.restoreSelectionState(selection);QApplication::processEvents();QVERIFY(countColour(theme::selectionBg())>20);
    v.focusSearchResult(0);v.setSearchQuery(QString(),false);QApplication::processEvents();QVERIFY(countColour(theme::selectionBg())>20);QCOMPARE(draft(v,source),source);
  }

  void fixtureInlineImagesReserveRealLineHeight() {
    const QString root=QFINDTESTDATA("../../tests/fixtures/full-document/document.md");QVERIFY(!root.isEmpty());
    // Dedicated fixture independent of user documents and removed root assets.
    QFile original(root);QVERIFY(original.open(QIODevice::ReadOnly));const QByteArray bytes=original.readAll();
    QTemporaryDir dir;QVERIFY(dir.isValid());QVERIFY(QDir(dir.path()).mkpath("assets/icons"));
    QImage png(300,300,QImage::Format_ARGB32);png.fill(Qt::blue);QVERIFY(png.save(dir.filePath("assets/icons/icon-source.png")));
    QFile copy(dir.filePath("fixture.md"));QVERIFY(copy.open(QIODevice::WriteOnly));QCOMPARE(copy.write(bytes),qint64(bytes.size()));copy.close();
    const QString source=QString::fromUtf8(bytes);DocumentView view;view.resize(822,932);view.show();
    view.setPlan(bridge::planFor(source).value("plan").toObject(),copy.fileName());view.setPreviewContext(source);QApplication::processEvents();view.relayout();
    int originalImageCount=-1;
    auto verifyGeometry=[&]() {
    int imageCount=0;bool contained=true;
    for(auto block=view.document()->begin();block.isValid();block=block.next()) {
      int count=0;for(auto it=block.begin();!it.atEnd();++it){const auto f=it.fragment();if(f.isValid()&&f.text().contains(QChar::ObjectReplacementCharacter)&&f.charFormat().hasProperty(QTextFormat::UserProperty+4))count+=f.text().count(QChar::ObjectReplacementCharacter);}
      if(!count)continue;imageCount+=count;const auto rect=view.document()->documentLayout()->blockBoundingRect(block);
      qInfo()<<"image block"<<block.blockNumber()<<"count"<<count<<"bounds"<<rect<<"lineheight/type"<<block.blockFormat().lineHeight()<<block.blockFormat().lineHeightType()<<"indent"<<block.blockFormat().textIndent();
      qreal previousBottom=0;
      // QTextLayout line bounds can extend below blockBoundingRect (font
      // leading); compare the actual ink allocation with the next block,
      // rather than requiring those two different Qt rectangles to coincide.
      auto* layout=block.layout();for(int n=0;n<layout->lineCount();++n){const auto line=layout->lineAt(n);qInfo()<<"image line"<<n<<"y/h/ascent"<<line.y()<<line.height()<<line.ascent();if(line.y() < previousBottom-1)contained=false;previousBottom=line.y()+line.height();}
      if(block.next().isValid()&&block.next().isVisible())contained=contained&&view.document()->documentLayout()->blockBoundingRect(block.next()).top()>=rect.top()+previousBottom-1;
    }
    QVERIFY(imageCount>=2);if(originalImageCount<0)originalImageCount=imageCount;else QCOMPARE(imageCount,originalImageCount);
    QVERIFY2(contained,"Inline image line protrudes outside allocated paragraph, overlapping neighboring text");
    };
    verifyGeometry();QCOMPARE(draft(view,source).toUtf8(),bytes);
    for(int width:{420,1000,822}){view.resize(width,932);QApplication::processEvents();verifyGeometry();QCOMPARE(draft(view,source).toUtf8(),bytes);}
    QTextBlock imageBlock;
    for(auto block=view.document()->begin();block.isValid();block=block.next())if(block.blockFormat().intProperty(QTextFormat::UserProperty+1)==6){imageBlock=block;break;}
    QVERIFY(imageBlock.isValid());view.restoreSelectionState({imageBlock.position()+imageBlock.length()-1,imageBlock.position()+imageBlock.length()-1});
    QTest::keyClicks(&view,"X");QApplication::processEvents();verifyGeometry();
    QVERIFY(draft(view,source).contains("X"));QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QApplication::processEvents();
    verifyGeometry();QCOMPARE(draft(view,source).toUtf8(),bytes);
  }
  void preeditUsesLayoutWithoutChangingSourceAndReflows() {
    const QString source="prefix suffix\n";DocumentView view;load(view,source,640);
    auto found=view.document()->find("suffix");QVERIFY(!found.isNull());
    view.restoreSelectionState({found.selectionStart(),found.selectionStart()});
    const auto block=view.cursor_.block();auto* layout=block.layout();const int at=view.cursor_.positionInBlock();
    const qreal before=layout->lineForTextPosition(at).cursorToX(at);const auto original=view.document()->toPlainText();
    composing(view,QStringLiteral("中文"),1);
    QCOMPARE(layout->preeditAreaText(),QStringLiteral("中文"));QCOMPARE(layout->preeditAreaPosition(),at);
    const qreal after=layout->lineForTextPosition(at+2).cursorToX(at+2);
    QVERIFY2(after>before+8,"Following text must make room for composition, not be covered by an overlay");
    QCOMPARE(view.document()->toPlainText(),original);QCOMPARE(draft(view,source),source);QVERIFY(!view.document()->isUndoAvailable());
    const int shortLines=layout->lineCount();composing(view,QStringLiteral("中文").repeated(90),10);
    QVERIFY2(layout->lineCount()>shortLines,"Long preedit must participate in line wrapping");
    QCOMPARE(view.document()->toPlainText(),original);
    composing(view,{},0);QVERIFY(layout->preeditAreaText().isEmpty());QVERIFY(!view.isComposing());
    QCOMPARE(layout->lineCount(),shortLines);QCOMPARE(draft(view,source),source);
  }
  void candidateRectangleTracksInternalCursorAndQueries() {
    const QString source="prefix suffix\n";DocumentView view;load(view,source);
    const auto found=view.document()->find("suffix");view.restoreSelectionState({found.selectionStart(),found.selectionStart()});
    const auto block=view.cursor_.block();const int at=view.cursor_.positionInBlock();
    composing(view,QStringLiteral("候选文本"),0);
    const QRectF first=view.inputMethodQuery(Qt::ImCursorRectangle).toRectF();
    composing(view,QStringLiteral("候选文本"),3);
    const QRectF current=view.inputMethodQuery(Qt::ImCursorRectangle).toRectF();
    const auto line=block.layout()->lineForTextPosition(at+3);const auto rect=view.document()->documentLayout()->blockBoundingRect(block);
    const qreal expected=rect.left()+line.cursorToX(at+3)+view.contentLeft();
    QVERIFY(current.left()>first.left()+8);QVERIFY(qAbs(current.left()-expected)<=2);
    QVERIFY(qAbs(current.top()-(rect.top()+line.y()+view.topPadding()-view.scrollValue()))<=2);
    QCOMPARE(view.inputMethodQuery(Qt::ImSurroundingText).toString(),block.text());
    QCOMPARE(view.inputMethodQuery(Qt::ImCursorPosition).toInt(),at);
    QCOMPARE(view.inputMethodQuery(Qt::ImAnchorPosition).toInt(),at);
    QVERIFY(view.inputMethodQuery(Qt::ImCurrentSelection).isValid());
    QVERIFY(view.inputMethodQuery(Qt::ImCurrentSelection).toString().isEmpty());
    QVERIFY(view.inputMethodQuery(Qt::ImFont).canConvert<QFont>());
    QVERIFY(view.inputMethodQuery(Qt::ImAnchorRectangle).toRectF().isValid());
    composing(view,{},0);
  }
  void selectionCompositionCommitsOnceAndUndoRestores() {
    const QString source="before SELECT after\n";DocumentView view;load(view,source);
    const auto selected=view.document()->find("SELECT");view.restoreSelectionState({selected.selectionStart(),selected.selectionEnd()});
    const auto original=view.document()->toPlainText();
    QCOMPARE(view.inputMethodQuery(Qt::ImCurrentSelection).toString(),QString("SELECT"));
    composing(view,QStringLiteral("替换"),1);
    QCOMPARE(view.document()->toPlainText(),original);QCOMPARE(draft(view,source),source);
    QCOMPARE(view.inputMethodQuery(Qt::ImCurrentSelection).toString(),QString("SELECT"));
    QInputMethodEvent commit;commit.setCommitString(QStringLiteral("替换"));QApplication::sendEvent(&view,&commit);
    QVERIFY(!view.isComposing());QVERIFY(view.cursor_.block().layout()->preeditAreaText().isEmpty());
    QCOMPARE(draft(view,source),QStringLiteral("before 替换 after\n"));
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(draft(view,source),source);
  }
  void entireMixedDocumentCompositionFlattensOnceAndUndoRestores() {
    const QString source="# Heading\n\n- first\n- second\n\n```text\ncode\n```\n";
    DocumentView view;load(view,source);
    const QString original=view.document()->toPlainText();
    QTest::keyClick(&view,Qt::Key_A,Qt::ControlModifier);QVERIFY(view.cursor_.hasSelection());
    composing(view,QStringLiteral("整篇替换"),2);
    QCOMPARE(view.document()->toPlainText(),original);QCOMPARE(draft(view,source),source);
    QInputMethodEvent commit;commit.setCommitString(QStringLiteral("整篇替换"));QApplication::sendEvent(&view,&commit);
    const QString replaced=draft(view,source);
    QCOMPARE(replaced.trimmed(),QStringLiteral("整篇替换"));
    const auto blocks=bridge::planFor(replaced).value("plan").toObject().value("blocks").toArray();
    QCOMPARE(blocks.size(),1);QCOMPARE(blocks.first().toObject().value("type").toString(),QString("paragraph"));
    QVERIFY(!view.isComposing());QVERIFY(view.cursor_.block().layout()->preeditAreaText().isEmpty());
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);
    QCOMPARE(draft(view,source),source);QCOMPARE(view.document()->toPlainText(),original);
  }
  void anchorRectangleUsesAnchorAcrossLinesNotCursor() {
    const QString source="first paragraph anchor\n\nsecond paragraph cursor\n";
    DocumentView view;load(view,source);
    const auto start=view.document()->find("anchor"),end=view.document()->find("cursor");QVERIFY(!start.isNull());QVERIFY(!end.isNull());
    const int anchor=start.selectionStart(),cursor=end.selectionEnd();view.restoreSelectionState({anchor,cursor});
    const QTextBlock block=view.document()->findBlock(anchor);const auto line=block.layout()->lineForTextPosition(anchor-block.position());
    const auto bounds=view.document()->documentLayout()->blockBoundingRect(block);
    const QRectF actual=view.inputMethodQuery(Qt::ImAnchorRectangle).toRectF();
    const QRectF caret=view.inputMethodQuery(Qt::ImCursorRectangle).toRectF();
    const qreal x=bounds.left()+line.cursorToX(anchor-block.position())+view.contentLeft()+view.viewport()->x();
    const qreal y=bounds.top()+line.y()+view.topPadding()-view.scrollValue()+view.viewport()->y();
    qInfo()<<"anchor"<<actual<<"cursor"<<caret<<"expected"<<QPointF(x,y);
    QVERIFY(qAbs(actual.left()-x)<=2);QVERIFY(qAbs(actual.top()-y)<=2);
    QVERIFY(actual.top()+actual.height()<caret.top());
    QCOMPARE(view.inputMethodQuery(Qt::ImCurrentSelection).toString(),view.cursor_.selectedText());
    QCOMPARE(draft(view,source),source);
  }
  void nonPopupFocusLossEndsTransientCompositionWithoutWritingSource() {
    const QString source="before after\n";DocumentView view;load(view,source);
    const auto found=view.document()->find("after");view.restoreSelectionState({found.selectionStart(),found.selectionStart()});
    const auto block=view.cursor_.block();const QString original=view.document()->toPlainText();
    composing(view,QStringLiteral("未提交"),2);QVERIFY(view.isComposing());
    // Synthetic preedit has no platform-owned commit; the fallback must discard
    // only transient layout state, never turn uncommitted text into authored text.
    QFocusEvent focus(QEvent::FocusOut,Qt::OtherFocusReason);QApplication::sendEvent(&view,&focus);QApplication::processEvents();
    QVERIFY(!view.isComposing());QVERIFY(block.layout()->preeditAreaText().isEmpty());
    QCOMPARE(view.document()->toPlainText(),original);QCOMPARE(draft(view,source),source);
    QVERIFY(!view.document()->isUndoAvailable());
  }
  void nineTaskItemsAreCompactAndDoNotCoverFollowingText() {
    const QString source=tasks();DocumentView view;load(view,source);QVERIFY(view.rawSurfaces_.isEmpty());
    qreal previous=-1,lastBottom=0;int count=0;
    for(auto block=view.document()->begin();block.isValid();block=block.next())if(block.text().contains("task ")) {
      QVERIFY(block.blockFormat().hasProperty(QTextFormat::UserProperty+36));
      const auto rect=view.document()->documentLayout()->blockBoundingRect(block);
      if(previous>=0){QCOMPARE(block.blockFormat().topMargin(),qreal(4));QVERIFY(qAbs(rect.top()-previous-32)<=2);}
      previous=rect.top();lastBottom=rect.bottom();++count;
    }
    QCOMPARE(count,9);
    const auto following=view.document()->find("Following paragraph").block();
    QVERIFY(lastBottom<=view.document()->documentLayout()->blockBoundingRect(following).top());
    QCOMPARE(draft(view,source),source);
  }
  void renderedTasksToggleSaveUndoAndReopen() {
    const QString source=tasks();QTemporaryDir dir;QVERIFY(dir.isValid());QFile file(dir.filePath("tasks.md"));
    QVERIFY(file.open(QIODevice::WriteOnly));file.write(source.toUtf8());file.close();
    const auto opened=bridge::openDocument(file.fileName());QVERIFY(opened.value("ok").toBool());
    const auto info=opened.value("document").toObject();DocumentView view;load(view,source);
    const auto block=view.document()->find("task 0").block();
    const QPoint marker=textPoint(view,block.text().left(1));QTest::mouseClick(view.viewport(),Qt::LeftButton,Qt::NoModifier,marker);
    QVERIFY(block.blockFormat().boolProperty(QTextFormat::UserProperty+36));
    QString expected=source;expected.replace(0,5,"- [x]");QCOMPARE(draft(view,source),expected);
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(draft(view,source),source);
    QTest::mouseClick(view.viewport(),Qt::LeftButton,Qt::NoModifier,marker);QCOMPARE(draft(view,source),expected);
    const auto saved=bridge::saveDocument(info.value("path").toString(),expected,info.value("sessionId").toString());QVERIFY(saved.value("ok").toBool());
    QVERIFY(file.open(QIODevice::ReadOnly));QCOMPARE(QString::fromUtf8(file.readAll()),expected);file.close();
    const auto reopened=bridge::openDocument(file.fileName());QVERIFY(reopened.value("ok").toBool());
    DocumentView again;load(again,expected);QVERIFY(again.rawSurfaces_.isEmpty());QCOMPARE(draft(again,expected),expected);
  }
  void fixtureChecklistEditsRenderedTextWithoutRawActivation() {
    const QString fixture=QFINDTESTDATA("../../tests/fixtures/full-document/document.md");QVERIFY(!fixture.isEmpty());
    // Never discover or modify an arbitrary document in the workspace root.
    QFile file(fixture);QVERIFY(file.open(QIODevice::ReadOnly));const QByteArray bytes=file.readAll();const QString source=QString::fromUtf8(bytes);
    DocumentView view;load(view,source);QCOMPARE(draft(view,source).toUtf8(),bytes);
    QTextBlock task;for(auto b=view.document()->begin();b.isValid();b=b.next())if(b.blockFormat().hasProperty(QTextFormat::UserProperty+36)){task=b;break;}
    QVERIFY(task.isValid());const QString text=task.text().mid(3).trimmed();QVERIFY(!text.isEmpty());
    QTest::mouseClick(view.viewport(),Qt::LeftButton,Qt::NoModifier,textPoint(view,text.left(4)));
    QVERIFY(view.cursor_.blockFormat().hasProperty(QTextFormat::UserProperty+36));
    for(const auto& surface:view.rawSurfaces_)QVERIFY(!surface.source);
    QTest::keyClicks(&view,"Z");QVERIFY(draft(view,source)!=source);
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);
    const auto restored=draft(view,source).toUtf8();int delta=0;while(delta<qMin(restored.size(),bytes.size())&&restored.at(delta)==bytes.at(delta))++delta;
    qInfo()<<"root undo first difference"<<delta<<"actual"<<restored.mid(qMax(0,delta-40),180)<<"expected"<<bytes.mid(qMax(0,delta-40),180);
    QCOMPARE(restored,bytes);
  }
  void renderedTaskImeAndInlineMarksRoundTrip() {
    const QString source="- [ ] **bold** `code` end\n  - [x] **nested *marks***\n";DocumentView view;load(view,source);
    QVERIFY(view.rawSurfaces_.isEmpty());QCOMPARE(draft(view,source),source);
    qInfo()<<"IME initial plain"<<view.document()->toPlainText()<<"plan"<<QJsonDocument(bridge::planFor(source)).toJson(QJsonDocument::Compact);
    QTest::mouseClick(view.viewport(),Qt::LeftButton,Qt::NoModifier,textPoint(view,"end"));
    auto found=view.document()->find("end");view.restoreSelectionState({found.selectionStart(),found.selectionStart()});
    qInfo()<<"IME clicked plain"<<view.document()->toPlainText()<<"selection"<<view.cursor_.anchor()<<view.cursor_.position();
    const QString original=view.document()->toPlainText();composing(view,QStringLiteral("\u4e2d\u6587"),1);
    QCOMPARE(view.document()->toPlainText(),original);QCOMPARE(draft(view,source),source);
    QInputMethodEvent event;event.setCommitString(QStringLiteral("\u4e2d\u6587"));QApplication::sendEvent(&view,&event);
    const QString edited=draft(view,source);qInfo()<<"task IME serialized"<<edited<<"plain"<<view.document()->toPlainText();QVERIFY(edited.contains("**bold**"));QVERIFY(edited.contains("`code`"));
    QVERIFY(edited.contains(QStringLiteral("\u4e2d\u6587end")));QVERIFY(edited.contains("[x]"));
    const auto editedList=bridge::planFor(edited).value("plan").toObject().value("blocks").toArray().first().toObject();
    const auto nested=editedList.value("items").toArray().first().toArray().last().toObject();
    QCOMPARE(nested.value("type").toString(),QString("list"));
    QCOMPARE(nested.value("tasks").toArray().first().toBool(),true);
    bool combined=false;for(const auto& run:nested.value("items").toArray().first().toArray().first().toObject().value("runs").toArray()) {
      const auto object=run.toObject();if(object.value("text").toString().contains("marks"))combined=object.value("bold").toBool()&&object.value("italic").toBool();
    }
    QVERIFY(combined);
    const auto plan=bridge::planFor(edited);QVERIFY(plan.value("ok").toBool());DocumentView reopened;load(reopened,edited);QCOMPARE(draft(reopened,edited),edited);
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(draft(view,source),source);
  }
  void renderedTaskSplitIndentExitAndUndo() {
    const QString source="- [x] alpha beta\n- [ ] second\n";DocumentView view;load(view,source);
    auto found=view.document()->find("beta");view.restoreSelectionState({found.selectionStart(),found.selectionStart()});
    QTest::keyClick(&view,Qt::Key_Return);QVERIFY(draft(view,source).contains("[ ] beta"));
    QVERIFY(view.cursor_.blockFormat().hasProperty(QTextFormat::UserProperty+36));QVERIFY(!view.cursor_.blockFormat().boolProperty(QTextFormat::UserProperty+36));
    QTest::keyClick(&view,Qt::Key_Tab);QVERIFY(view.cursor_.blockFormat().leftMargin()>24);
    QTest::keyClick(&view,Qt::Key_Backtab);QCOMPARE(view.cursor_.blockFormat().leftMargin(),qreal(24));
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(draft(view,source),source);
    found=view.document()->find("beta");view.restoreSelectionState({found.selectionEnd(),found.selectionEnd()});QTest::keyClick(&view,Qt::Key_Return);
    QTest::keyClick(&view,Qt::Key_Backspace);QVERIFY(!view.cursor_.blockFormat().hasProperty(QTextFormat::UserProperty+36));
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(draft(view,source),source);
  }
  void fullFixtureRawParentAllocationMatchesPreviewHeight() {
    QString source="<div><ul>";for(int i=0;i<9;++i)source+=QString("<li>item %1 long preview text for hidden width reflow</li>").arg(i);
    source+="</ul></div>\n\n# Following heading\n\n<div><p>Second preview</p></div>\n";const QByteArray bytes=source.toUtf8();
    DocumentView view;view.resize(100,100);view.setPlan(bridge::planFor(source).value("plan").toObject(),{});view.setPreviewContext(source);
    view.resize(822,932);view.show();QApplication::processEvents();
    // Do not manually relayout: exercise delayed hidden-widget resize delivery.
    for(int pass=0;pass<5;++pass) {
      if(pass) {view.hide();view.resize(pass%2 ? 420 : 822,932);view.show();QApplication::processEvents();}
      qInfo()<<"allocation pass/width"<<pass<<view.width();
    int inspected=0;bool allocation=true;constexpr int owner=QTextFormat::UserProperty+28;
    for(const auto& surface:view.rawSurfaces_) {
      if(!surface.preview)continue;
      auto* child=surface.preview.data();
      for(auto block=view.document()->begin();block.isValid();block=block.next()) {
        if(!block.blockFormat().hasProperty(owner)||block.blockFormat().intProperty(owner)!=surface.node)continue;
        const auto rect=view.document()->documentLayout()->blockBoundingRect(block);
        auto next=block.next();while(next.isValid()&&!next.isVisible())next=next.next();
        const auto nextRect=next.isValid()?view.document()->documentLayout()->blockBoundingRect(next):QRectF();
        const qreal expected=child->document()->size().height()+child->topPadding()+child->bottomPadding();
        qInfo()<<"raw parent node/rect"<<surface.node<<rect<<"child document/geometry/expected"<<child->document()->size()<<child->geometry()<<expected
          <<"format lineHeight/type"<<block.blockFormat().lineHeight()<<block.blockFormat().lineHeightType()<<"layout position"<<block.layout()->position()
          <<"next"<<nextRect<<"next text"<<next.text().left(24);
        for(int i=0;i<block.layout()->lineCount();++i){const auto line=block.layout()->lineAt(i);qInfo()<<"parent line"<<i<<line.y()<<line.height()<<line.ascent()<<line.descent();}
        const auto previous=block.previous();if(previous.isValid())qInfo()<<"raw source previous visible/lines/rect"<<previous.isVisible()<<previous.lineCount()<<view.document()->documentLayout()->blockBoundingRect(previous);
        allocation=allocation && rect.height()<=expected+32 && (!next.isValid()||nextRect.top()<=rect.top()+expected+80);
        ++inspected;
      }
    }
    QVERIFY(inspected>=2);QVERIFY2(allocation,"Raw parent reserves far more height than its measured preview; inspect logged parent/child geometries");
    QCOMPARE(draft(view,source).toUtf8(),bytes);
    }
  }
  void clickAndEnterActivateSourceThenSavePreservesTaskStructure_data() {
    QTest::addColumn<bool>("keyboard");QTest::newRow("click")<<false;QTest::newRow("enter")<<true;
  }
  void clickAndEnterActivateSourceThenSavePreservesTaskStructure() {
    QFETCH(bool,keyboard);const QString source="<div><p>raw editable text</p></div>\n";QTemporaryDir dir;QVERIFY(dir.isValid());
    QFile file(dir.filePath("tasks.md"));QVERIFY(file.open(QIODevice::WriteOnly));file.write(source.toUtf8());file.close();
    const auto opened=bridge::openDocument(file.fileName());QVERIFY(opened.value("ok").toBool());
    const QString path=opened.value("document").toObject().value("path").toString();
    DocumentView view;load(view,source);const int node=view.rawSurfaces_.begin().value().node;auto* child=view.rawSurfaces_[node].preview.data();
    if(keyboard){child->setFocus();QTest::keyClick(child,Qt::Key_Return);}else QTest::mouseClick(child->viewport(),Qt::LeftButton,Qt::NoModifier,textPoint(*child,"raw editable text"));
    QVERIFY(view.rawSurfaces_[node].source);QVERIFY(view.hasFocus());
    QVERIFY(view.revealText("editable"));QTest::keyClicks(&view,"changed");
    QString expected=source;expected.replace("editable","changed");
    QCOMPARE(draft(view,source),expected);
    const auto saved=bridge::saveDocument(path,expected,{});QVERIFY(saved.value("ok").toBool());
    QVERIFY(file.open(QIODevice::ReadOnly));QCOMPARE(QString::fromUtf8(file.readAll()),expected);file.close();
    view.setPreviewContext(expected);view.setRawSourceVisible(node,false,false);QVERIFY(!view.rawSurfaces_[node].source);
    QCOMPARE(draft(view,source),expected);
    const auto plan=bridge::planFor(expected).value("plan").toObject().value("blocks").toArray().first().toObject();
    QCOMPARE(plan.value("type").toString(),QString("raw"));
    QVERIFY(!plan.value("preview").toObject().value("blocks").toArray().isEmpty());
  }
  void draggingAndControlLinkDoNotActivateSource() {
    const QString source="<div><p>select words <a href=\"https://example.com\">link</a></p></div>\n";DocumentView view;load(view,source);
    const int node=view.rawSurfaces_.begin().value().node;auto* child=view.rawSurfaces_[node].preview.data();
    const QPoint from=textPoint(*child,"select"),to=textPoint(*child,"words");
    QTest::mousePress(child->viewport(),Qt::LeftButton,Qt::NoModifier,from);
    QMouseEvent move(QEvent::MouseMove,to,child->viewport()->mapToGlobal(to),Qt::NoButton,Qt::LeftButton,Qt::NoModifier);QApplication::sendEvent(child->viewport(),&move);
    QTest::mouseRelease(child->viewport(),Qt::LeftButton,Qt::NoModifier,to);
    QVERIFY(!view.rawSurfaces_[node].source);QVERIFY(!child->selectedText().isEmpty());
    QSignalSpy links(&view,&DocumentView::linkActivated);
    QTest::mouseClick(child->viewport(),Qt::LeftButton,Qt::ControlModifier,textPoint(*child,"link"));
    QCOMPARE(links.count(),1);QVERIFY(!view.rawSurfaces_[node].source);QCOMPARE(draft(view,source),source);
  }
  void previewCodeCopyDoesNotActivateSource() {
    const QString source="<div><pre><code>copy-me</code></pre></div>\n";DocumentView view;load(view,source);
    QVERIFY(!view.rawSurfaces_.isEmpty());const int node=view.rawSurfaces_.begin().value().node;auto* child=view.rawSurfaces_[node].preview.data();
    // Match code_copy_regressions: capture the actual payload at the platform
    // writer boundary. Offscreen QClipboard cannot read the Win32 clipboard,
    // and this test must not overwrite the user's real clipboard to inspect it.
    auto* captured=new CapturingPreview(view.viewport());
    captured->previewMode_=true;captured->readOnly_=true;
    captured->setGeometry(child->geometry());
    captured->setPlan(view.rawSurfaces_[node].plan,{});
    connect(captured,&DocumentView::sourceEditRequested,&view,[&view,node]{view.setRawSourceVisible(node,true);});
    view.rawSurfaces_[node].preview=captured;delete child;child=captured;
    view.relayout();QApplication::processEvents();
    qInfo()<<"copy fixture plan"<<QJsonDocument(bridge::planFor(source)).toJson(QJsonDocument::Compact);
    qInfo()<<"copy child"<<child->geometry()<<child->viewport()->rect()<<"regions"<<child->horizontalRegions_.size();
    bool clicked=false;
    for(const auto& region:child->horizontalRegions_)if(!region.copy.isEmpty()) {
      const QPoint point=(region.copy.center()+QPointF(child->contentLeft(),child->topPadding()-child->scrollValue())).toPoint();
      qInfo()<<"copy region"<<region.node<<region.rect<<region.copy<<point;
      QTest::mouseClick(child->viewport(),Qt::LeftButton,Qt::NoModifier,point);clicked=true;break;
    }
    qInfo()<<"captured copy"<<captured->writes<<captured->written<<"error"<<child->copyErrorNode_;
    QVERIFY(clicked);QCOMPARE(captured->writes,1);QCOMPARE(captured->written,QString("copy-me"));
    QVERIFY(!view.rawSurfaces_[node].source);QCOMPARE(draft(view,source),source);
  }
};
QTEST_MAIN(ImeRawRegressions)
#include "ime_raw_regressions.moc"
