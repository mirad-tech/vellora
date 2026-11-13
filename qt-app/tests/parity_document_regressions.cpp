#include <QtWidgets>
#include <QtTest>
#include "bridge.h"
#include "document_view.h"

class ParityDocumentRegressions : public QObject {
  Q_OBJECT
  static void load(DocumentView& view, const QString& source) {
    view.resize(820, 600); view.show();
    view.setPlan(bridge::planFor(source).value("plan").toObject(), {});
    view.setPreviewContext(source); QCoreApplication::processEvents(); view.relayout();
  }
  static QString draft(DocumentView& view, const QString& source) {
    QJsonArray edits;
    for (const auto& edit : view.pendingEdits()) edits.append(QJsonObject{{"index",edit.first},{"markdown",edit.second}});
    return bridge::spliceSegments(source, edits).value("content").toString();
  }
  static qreal separation(DocumentView& view, const QString& a, const QString& b) {
    const auto first=view.document()->find(a), second=view.document()->find(b);
    if (first.isNull() || second.isNull()) return -1;
    return view.document()->documentLayout()->blockBoundingRect(second.block()).top()
        - view.document()->documentLayout()->blockBoundingRect(first.block()).top();
  }
 private slots:
  void generatedMarkersNeverSearchOrReplace_data() {
    QTest::addColumn<QString>("source"); QTest::addColumn<QString>("query");
    QTest::newRow("ordered") << QString("1. Open document\n2. Edit document\n") << QString("1.");
    QTest::newRow("marker-prefix-span") << QString("1. Open document\n") << QString("1. Open");
    QTest::newRow("bullet") << QString("- Open document\n- Edit document\n") << QString::fromUtf8("\xe2\x80\xa2");
    QTest::newRow("nested-number") << QString("- Parent\n  1. Open document\n  2. Edit document\n") << QString("1.");
  }
  void generatedMarkersNeverSearchOrReplace() {
    QFETCH(QString, source); QFETCH(QString, query);
    QTemporaryDir directory; QVERIFY(directory.isValid());
    const QString path=directory.filePath("copy.md"); QFile file(path); QVERIFY(file.open(QIODevice::WriteOnly)); file.write(source.toUtf8()); file.close();
    const auto opened=bridge::openDocument(path); QVERIFY(opened.value("ok").toBool());
    const QString sessionPath=opened.value("document").toObject().value("path").toString(); QVERIFY(!sessionPath.isEmpty());
    DocumentView view; load(view,source); view.setSearchQuery(query,true);
    QCOMPARE(view.searchMatchCount(),0); QVERIFY(!view.replaceCurrent("X")); QCOMPARE(view.replaceAll("X"),0);
    QCOMPARE(draft(view,source),source); QVERIFY(view.pendingEdits().isEmpty());
    const auto saved=bridge::saveDocument(sessionPath,draft(view,source),{});
    QVERIFY2(saved.value("ok").toBool(),qPrintable(QJsonDocument(saved).toJson()));
    QVERIFY(file.open(QIODevice::ReadOnly)); QCOMPARE(file.readAll(),source.toUtf8());
  }
  void authoredNumberInListRemainsSearchableAndUndoable() {
    const QString source="1. Literal 1. in body\n2. Keep this item\n";
    DocumentView view; load(view,source); view.setSearchQuery("1.",true);
    QCOMPARE(view.searchMatchCount(),1); QVERIFY(view.replaceCurrent("X"));
    QCOMPARE(draft(view,source),QString("1. Literal X in body\n2. Keep this item\n"));
    QTest::keyClick(&view,Qt::Key_Z,Qt::ControlModifier); QCOMPARE(draft(view,source),source);
    QTest::keyClick(&view,Qt::Key_Y,Qt::ControlModifier); QVERIFY(draft(view,source).contains("Literal X"));
  }
  void taskPreviewSpacingDoesNotAffectOrdinaryOrCompactHtmlLists() {
    const QString task="- [x] First task\n- [ ] Second task\n- [ ] Third task\n\nFollowing paragraph\n";
    DocumentView view; load(view,task); QVERIFY(view.rawSurfaces_.isEmpty());
    QCOMPARE(separation(view,"First task","Second task"),32.0);
    QCOMPARE(separation(view,"Second task","Third task"),32.0);
    view.setPreviewContext(task+"\n[ref]: elsewhere.md\n");
    QCOMPARE(separation(view,"First task","Second task"),32.0);
    QCOMPARE(draft(view,task),task);
    const QString ordinary="- First item\n- Second item\n";
    load(view,ordinary); QCOMPARE(separation(view,"First item","Second item"),32.0); QCOMPARE(draft(view,ordinary),ordinary);
    const QString html="<ul><li>First html</li><li>Second html</li></ul>\n";
    load(view,html); QVERIFY(!view.rawSurfaces_.isEmpty()); auto* preview=view.rawSurfaces_.begin().value().preview.data(); QVERIFY(preview);
    QCOMPARE(separation(*preview,"First html","Second html"),32.0); QCOMPARE(draft(view,html),html);
  }
  void outlineScrollAnimatesAndCanBeInterruptedOrRetargeted() {
    const QString source="# First\n\n"+QString("Paragraph content.\n\n").repeated(90)+"# Last\n\n"+QString("Tail.\n\n").repeated(15);
    DocumentView view; load(view,source); QSignalSpy values(view.verticalScrollBar(),&QScrollBar::valueChanged);
    QVERIFY(view.revealHeading(1));
    auto* animation=view.findChild<QPropertyAnimation*>("headingScrollAnimation");
    if (!animation) { QVERIFY(view.scrollValue()>0); return; } // System reduced-motion preference.
    QCOMPARE(animation->state(),QAbstractAnimation::Running); QCOMPARE(view.scrollValue(),0);
    QTRY_VERIFY_WITH_TIMEOUT(view.scrollValue()>0,300);
    const int target=animation->endValue().toInt(); QVERIFY(view.scrollValue()<target);
    QVERIFY(view.revealHeading(0)); const int firstTarget=animation->endValue().toInt(); QTRY_COMPARE_WITH_TIMEOUT(animation->state(),QAbstractAnimation::Stopped,1000); QCOMPARE(view.scrollValue(),firstTarget);
    QVERIFY(view.revealHeading(1)); QTest::qWait(40);
    view.setScrollValue(12); QTest::qWait(500); QCOMPARE(view.scrollValue(),12);
    QVERIFY(view.revealHeading(1)); QTest::qWait(40);
    QWheelEvent wheel(QPointF(100,100),view.mapToGlobal(QPoint(100,100)),{},QPoint(0,-120),Qt::NoButton,Qt::NoModifier,Qt::NoScrollPhase,false);
    QApplication::sendEvent(view.viewport(),&wheel); QCOMPARE(animation->state(),QAbstractAnimation::Stopped);
    const int afterWheel=view.scrollValue(); QTest::qWait(500); QCOMPARE(view.scrollValue(),afterWheel);
    QVERIFY(view.revealHeading(1)); view.resize(620,600);
    QCOMPARE(animation->state(),QAbstractAnimation::Stopped);
    QVERIFY(view.revealHeading(1)); view.setPlan(bridge::planFor("# Other\n").value("plan").toObject(),{});
    QTest::qWait(500); QCOMPARE(view.scrollValue(),0); QCOMPARE(animation->state(),QAbstractAnimation::Stopped);
    QVERIFY(values.count()>3); QCOMPARE(draft(view,"# Other\n"),QString("# Other\n"));
  }
  void mixedAndNestedTaskFallbackSpacing() {
    const QString source="- Ordinary item\n- [ ] First task\n- [ ] Second task\n  - [x] Nested one\n  - [ ] Nested two\n";
    DocumentView view; load(view,source); QVERIFY(view.rawSurfaces_.isEmpty());
    QCOMPARE(separation(view,"Ordinary item","First task"),32.0);
    QCOMPARE(separation(view,"First task","Second task"),32.0);
    QCOMPARE(separation(view,"Nested one","Nested two"),32.0);
    QCOMPARE(draft(view,source),source);
  }
};
QTEST_MAIN(ParityDocumentRegressions)
#include "parity_document_regressions.moc"
