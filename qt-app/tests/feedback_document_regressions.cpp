#include <QtTest>
#include <QApplication>
#include <QJsonDocument>
#include <QAbstractTextDocumentLayout>
#include <QInputMethodEvent>
#include <QTemporaryDir>
#include <QFile>
#include <QtMath>
#include <QPushButton>
#include <QScrollBar>
#include <QTextBlock>
#include <QTextLayout>
#include <QTextTable>
#include <QWheelEvent>
#include "document_view.h"
#include "bridge.h"

class FeedbackDocumentRegressions : public QObject {
  Q_OBJECT
  static void load(DocumentView& view, const QString& source) {
    view.resize(820,700); view.show();
    view.setPlan(bridge::planFor(source).value("plan").toObject(),QString());
    view.setPreviewContext(source); QApplication::processEvents(); view.relayout();
  }
  static QString draft(DocumentView& view,const QString& source) {
    QJsonArray edits; for(const auto& edit:view.pendingEdits()) edits.append(QJsonObject{{"index",edit.first},{"markdown",edit.second}});
    return bridge::spliceSegments(source,edits).value("content").toString();
  }
 private slots:
  void adjacentFencesAndRawPreKeepSpacingAndFullPadding() {
    const QString source="```javascript\nconst sample = 1;\n  next();\n```\n\n```\nindented\n  keep spaces\n```\n\n<pre><code>RAW_COPY\n  中文 &amp; emoji 🧭</code></pre>\n\nTail\n";
    DocumentView view;load(view,source);
    QCOMPARE(view.codeBoxes_.size(),2);QCOMPARE(view.rawSurfaces_.size(),1);
    auto* preview=view.rawSurfaces_.begin()->preview.data();QVERIFY(preview);
    for(int width:{820,500,1030}) {
      view.resize(width,700);QApplication::processEvents();view.relayout();QApplication::processEvents();
      QCOMPARE(preview->codeBoxes_.size(),1);
      const auto second=view.codeBoxes_.last().rect;
      const auto raw=preview->codeBoxes_.first().rect.translated(0,preview->y()-view.topPadding()+view.scrollValue()+preview->topPadding());
      qInfo()<<"width"<<width<<"second"<<second<<"raw"<<raw<<"preview viewport"<<preview->viewport()->size()<<"local code"<<preview->codeBoxes_.first().rect;
      QVERIFY2(raw.top()-second.bottom()>=15.5,"Fenced and HTML pre code surfaces need a real 16px outer gap");
      QVERIFY2(preview->viewport()->height()>=qCeil(preview->codeBoxes_.first().rect.bottom()+preview->topPadding()),"Raw pre bottom padding and rounded corners must fit inside its viewport");
      const auto tail=view.document()->find("Tail");QVERIFY(!tail.isNull());
      const auto tailRect=view.document()->documentLayout()->blockBoundingRect(tail.block());
      QVERIFY(tailRect.top()-raw.bottom()>=15.5);
      QCOMPARE(draft(view,source),source);QVERIFY(!view.document()->isUndoAvailable());
    }
  }

  void rawCodeBoundaryVariants_data() {
    QTest::addColumn<QString>("source");
    const QString raw="<pre><code>RAW\n  中文 &amp; emoji 🧭</code></pre>";
    const QString fence="```\nFENCE\n  spaces\n```";
    QTest::newRow("raw-fenced")<<(raw+"\n\n"+fence+"\n");
    QTest::newRow("raw-raw")<<(raw+"\n\n"+raw+"\n");
    QTest::newRow("raw-paragraph-link")<<(raw+"\n\nFollowing [link](https://example.com)\n");
    QTest::newRow("raw-at-end")<<("Before\n\n"+raw+"\n");
  }
  void rawCodeBoundaryVariants() {
    QFETCH(QString,source);
    DocumentView view;load(view,source);
    for(int width:{820,500}) {
      view.resize(width,700);QApplication::processEvents();view.relayout();QApplication::processEvents();
      QVector<QRectF> surfaces;for(const auto& code:view.codeBoxes_)surfaces.append(code.rect);
      for(const auto& raw:view.rawSurfaces_) {
        QVERIFY(raw.preview);QVERIFY(!raw.preview->codeBoxes_.isEmpty());
        const auto local=raw.preview->codeBoxes_.last().rect;
        QVERIFY(raw.preview->viewport()->height()>=qCeil(local.bottom()+raw.preview->topPadding()));
        const auto global=local.translated(0,raw.preview->y()-view.topPadding()+view.scrollValue()+raw.preview->topPadding());
        surfaces.append(global);
      }
      std::sort(surfaces.begin(),surfaces.end(),[](const QRectF& a,const QRectF& b){return a.top()<b.top();});
      for(int i=1;i<surfaces.size();++i)QVERIFY2(surfaces[i].top()-surfaces[i-1].bottom()>=15.5,"Adjacent raw/fenced code backgrounds must stay separated");
      const auto following=view.document()->find("Following");
      if(!following.isNull())QVERIFY(view.document()->documentLayout()->blockBoundingRect(following.block()).top()-surfaces.last().bottom()>=15.5);
      for(int node:view.rawSurfaces_.keys()){view.setRawSourceVisible(node,true,false);view.setRawSourceVisible(node,false,false);}
      QCOMPARE(draft(view,source),source);QVERIFY(!view.document()->isUndoAvailable());
    }
    const auto reloaded=draft(view,source);load(view,reloaded);QCOMPARE(draft(view,reloaded),source);
    QTemporaryDir temporary;QVERIFY(temporary.isValid());QFile file(temporary.filePath("code.md"));
    QVERIFY(file.open(QIODevice::WriteOnly));file.write(source.toUtf8());file.close();
    const auto opened=bridge::openDocument(file.fileName());QVERIFY(opened.value("ok").toBool());
    const auto path=opened.value("document").toObject().value("path").toString();
    const auto saved=bridge::saveDocument(path,draft(view,source),QString());QVERIFY(saved.value("ok").toBool());
    QVERIFY(file.open(QIODevice::ReadOnly));QCOMPARE(file.readAll(),source.toUtf8());
  }
  void rawPreviewHasNoToggleAndDoesNotCoverFollowingQuote() {
    const QString source="- [x] Complete\n- [ ] Pending\n\n> First quote line\n>\n> > Nested quote\n";
    DocumentView view; load(view,source);
    QVERIFY(view.rawSurfaces_.isEmpty());
    QVERIFY(view.findChildren<QPushButton*>().isEmpty());
    const auto quote=view.document()->find("First quote line"); QVERIFY(!quote.isNull());
    const auto quoteRect=view.document()->documentLayout()->blockBoundingRect(quote.block());
    const auto complete=view.document()->find("Complete"); QVERIFY(!complete.isNull());
    const auto pending=view.document()->find("Pending"); QVERIFY(!pending.isNull());
    const auto completeRect=view.document()->documentLayout()->blockBoundingRect(complete.block());
    const auto pendingRect=view.document()->documentLayout()->blockBoundingRect(pending.block());
    QCOMPARE(pendingRect.top()-completeRect.top(),32.0);
    QVERIFY2(pendingRect.bottom()<=quoteRect.top(),"Rendered tasks must not cover the following quote");
    QCOMPARE(draft(view,source),source);
    QVERIFY(view.revealText("Pending"));
    QVERIFY(view.findChildren<QPushButton*>().isEmpty());
    QCOMPARE(draft(view,source),source);
  }
  void tableVisualAlignmentIsLeftButMarkdownMarkersSurviveEdit() {
    const QString source="| Left | Centre | Right |\n| :--- | :---: | ---: |\n| one | two | three |\n";
    QTemporaryDir directory; QVERIFY(directory.isValid());
    const QString path=directory.filePath("alignment.md");
    QFile fixture(path); QVERIFY(fixture.open(QIODevice::WriteOnly)); QCOMPARE(fixture.write(source.toUtf8()),source.toUtf8().size()); fixture.close();
    const auto opened=bridge::openDocument(path); QVERIFY(opened.value("ok").toBool());
    const QString sessionPath=opened.value("document").toObject().value("path").toString(); QVERIFY(!sessionPath.isEmpty());
    DocumentView view; load(view,source); QVERIFY(!view.tableRefs_.isEmpty());
    QTextTable* table=view.tableRefs_.first().table; QVERIFY(table);
    for(int r=0;r<table->rows();++r)for(int c=0;c<table->columns();++c) {
      const auto cell=table->cellAt(r,c);
      QVERIFY(cell.format().toTableCellFormat().leftPadding()>0);
      QVERIFY(cell.format().toTableCellFormat().leftPadding()<=12);
      for(auto it=cell.begin();!it.atEnd();++it) if(it.currentBlock().isValid())
        QCOMPARE(it.currentBlock().blockFormat().alignment(),Qt::Alignment(Qt::AlignLeft));
    }
    QCOMPARE(draft(view,source),source);
    QVERIFY(view.revealText("two")); QTest::keyClicks(&view,"changed");
    const auto saved=draft(view,source);
    const auto plan=bridge::planFor(saved).value("plan").toObject();
    QCOMPARE(plan.value("blocks").toArray().first().toObject().value("align").toArray(),QJsonArray({"left","center","right"}));
    QVERIFY(saved.contains("changed"));
    QVERIFY(saved.contains("| :--- | :---: | ---: |"));
    const auto result=bridge::saveDocument(sessionPath,saved,QString()); QVERIFY2(result.value("ok").toBool(),qPrintable(QJsonDocument(result).toJson()));
    QVERIFY(fixture.open(QIODevice::ReadOnly)); QCOMPARE(QString::fromUtf8(fixture.readAll()),saved); fixture.close();
  }
  void longCodeScrollsLocallyWithSeparatedTextCopyAndTrack() {
    const QString line="begin_"+QString(220,'x')+"_end";
    const QString source="```text\n"+line+"\n```\n\nNeighbour paragraph\n";
    DocumentView view; load(view,source); QVERIFY(!view.horizontalRegions_.isEmpty());
    auto region=view.horizontalRegions_.first(); QVERIFY(region.maximum>0);
    const auto code=view.document()->findBlock(region.blockPosition);
    QCOMPARE(code.layout()->lineCount(),1);
    const auto codeBounds=view.document()->documentLayout()->blockBoundingRect(code);
    const auto textLine=code.layout()->lineAt(0);
    QString geometry;
    { QDebug debug(&geometry); debug << "block" << codeBounds << "layout.position" << code.layout()->position()
        << "line y/height/ascent/descent" << textLine.y() << textLine.height() << textLine.ascent() << textLine.descent()
        << "clip" << region.rect << "track" << region.track << "copy" << region.copy; }
    qInfo().noquote() << geometry;
    QVERIFY2(region.rect.top()<=codeBounds.top()+textLine.y(),qPrintable(geometry));
    QVERIFY2(region.rect.bottom()+0.5>=codeBounds.top()+textLine.y()+textLine.height(),qPrintable(geometry));
    QVERIFY(region.rect.right()<region.copy.left());
    QVERIFY(region.track.top()>=region.rect.bottom());
    QVERIFY(region.thumb.width()>=24);
    const auto paragraph=view.document()->find("Neighbour paragraph").block();
    const auto before=view.document()->documentLayout()->blockBoundingRect(paragraph);
    qInfo() << "following paragraph" << before << "code background" << view.codeBoxes_.first().rect;
    QVERIFY2(region.track.bottom()<before.top(),qPrintable(geometry));
    QVERIFY2(view.codeBoxes_.first().rect.bottom()<=before.top(),qPrintable(geometry));
    const QPointF position=region.rect.center()+QPointF(view.contentLeft(),view.topPadding()-view.scrollValue());
    QWheelEvent wheel(position,view.viewport()->mapToGlobal(position.toPoint()),QPoint(-100,0),QPoint(),Qt::NoButton,Qt::NoModifier,Qt::NoScrollPhase,false);
    QApplication::sendEvent(view.viewport(),&wheel);
    QVERIFY(view.horizontalRegions_.first().scroll>0);
    QCOMPARE(view.horizontalScrollBar()->maximum(),0);
    QCOMPARE(view.document()->documentLayout()->blockBoundingRect(paragraph),before);
    QCOMPARE(draft(view,source),source);
    QVERIFY(view.revealText("_end"));
    QInputMethodEvent commit; commit.setCommitString(QString::fromUtf8("中文")); QApplication::sendEvent(&view,&commit);
    QVERIFY(draft(view,source).contains(QString::fromUtf8("中文")));
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier); QCOMPARE(draft(view,source),source);
  }
};
QTEST_MAIN(FeedbackDocumentRegressions)
#include "feedback_document_regressions.moc"
