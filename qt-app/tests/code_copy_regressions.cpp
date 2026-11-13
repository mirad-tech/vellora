#include <QtTest>
#include <QApplication>
#include <QAccessible>
#include <QTextDocument>
#include "document_view.h"
#include "bridge.h"

class ClipboardView : public DocumentView {
 public:
  bool accepts = true;
  QString written;
  int writes = 0;
  using DocumentView::copyCodeText;
 protected:
  bool writeCodeClipboard(const QString& text) override {
    written = text; ++writes; return accepts;
  }
};

class CodeCopyRegressions : public QObject {
  Q_OBJECT
  static void load(DocumentView& view, const QString& text) {
    view.resize(900,600);
    view.setPlan(bridge::planFor(text).value("plan").toObject(), QString());
  }
 private slots:
  void copyPreservesContentSelectionAndUndo() {
    ClipboardView view; load(view,"```text\nhello\nworld\n```\n\nTail\n");
    const auto original=view.document()->toPlainText();
    view.revealText("Tail"); const auto selection=view.selectionState();
    QSignalSpy edits(&view,&DocumentView::contentEdited);
    view.copyCodeText(0,QString::fromUtf8("hello\n世界"));
    QCOMPARE(view.writes,1); QCOMPARE(view.written,QString::fromUtf8("hello\n世界"));
    QCOMPARE(view.accessibleDescription(),QString::fromUtf8("已复制"));
    auto* accessible=QAccessible::queryAccessibleInterface(&view);
    QVERIFY(accessible); QCOMPARE(accessible->text(QAccessible::Description),view.accessibleDescription());
    QCOMPARE(view.document()->toPlainText(),original); QCOMPARE(view.selectionState(),selection);
    QCOMPARE(edits.count(),0); QVERIFY(!view.hasPendingEdits()); QVERIFY(!view.document()->isUndoAvailable());
  }
  void failurePersistsAndCanRetry() {
    ClipboardView view; load(view,"```\nx\n```\n"); view.accepts=false;
    view.copyCodeText(0,"x");
    QVERIFY(view.accessibleDescription().contains(QString::fromUtf8("失败")));
    QTest::qWait(2600);
    QVERIFY(view.accessibleDescription().contains(QString::fromUtf8("失败")));
    view.accepts=true;view.copyCodeText(0,"x");
    QCOMPARE(view.writes,2); QCOMPARE(view.accessibleDescription(),QString::fromUtf8("已复制"));
    QTest::qWait(2100);
    QCOMPARE(view.accessibleDescription(),QString::fromUtf8("已复制"));
    QTRY_VERIFY_WITH_TIMEOUT(view.accessibleDescription().isEmpty(),1000);
  }
  void newerFeedbackOutlivesPreviousSuccessTimer() {
    ClipboardView view;load(view,"```\nx\n```\n");
    view.copyCodeText(0,"x"); QTest::qWait(1350);
    view.copyCodeText(1,"y"); QTest::qWait(1350);
    QCOMPARE(view.accessibleDescription(),QString::fromUtf8("已复制"));
    view.accepts=false;view.copyCodeText(1,"z"); QTest::qWait(1350);
    QVERIFY(view.accessibleDescription().contains(QString::fromUtf8("失败")));
  }
  void replacementPlanAndCloseResetFeedback() {
    ClipboardView view;load(view,"```\nx\n```\n");view.copyCodeText(0,"x");
    load(view,"Next\n");QVERIFY(view.accessibleDescription().isEmpty());
    view.accepts=false;view.copyCodeText(0,"y");view.setEmptyState();
    QVERIFY(!view.accessibleDescription().contains(QString::fromUtf8("复制失败")));
  }
  void replaceAdvancesToNextOriginalMatch() {
    DocumentView view;load(view,"a a a\n");view.setSearchQuery("a",true);
    QVERIFY(view.replaceCurrent("aa"));QCOMPARE(view.document()->lastBlock().text(),QString("aa a a"));
    QCOMPARE(view.searchActiveIndex(),2);
    QVERIFY(view.replaceCurrent("aa"));QCOMPARE(view.document()->lastBlock().text(),QString("aa aa a"));
    QCOMPARE(view.searchActiveIndex(),4);
    QVERIFY(view.replaceCurrent("aa"));QCOMPARE(view.document()->lastBlock().text(),QString("aa aa aa"));
    QCOMPARE(view.searchActiveIndex(),-1);
    QCoreApplication::processEvents();view.setSearchQuery("a",true);
    QCOMPARE(view.searchActiveIndex(),-1);QVERIFY(!view.replaceCurrent("aa"));
  }
  void replaceStopsWhenOldAdjacentRangeDisappears() {
    DocumentView view;load(view,"aaaa\n");view.setSearchQuery("aa",true);
    QVERIFY(view.replaceCurrent("a"));QCOMPARE(view.document()->lastBlock().text(),QString("aaa"));
    QCOMPARE(view.searchActiveIndex(),-1);QCoreApplication::processEvents();QCOMPARE(view.searchActiveIndex(),-1);
  }
  void noOpAdvancesWithoutDirtyOrUndo() {
    DocumentView view;load(view,"a a\n");view.setSearchQuery("a",true);
    QSignalSpy edits(&view,&DocumentView::contentEdited);
    QVERIFY(!view.replaceCurrent("a"));QCOMPARE(view.searchActiveIndex(),1);
    QVERIFY(!view.replaceCurrent("a"));QCOMPARE(view.searchActiveIndex(),-1);
    QCOMPARE(edits.count(),0);QVERIFY(!view.hasPendingEdits());QVERIFY(!view.document()->isUndoAvailable());
  }
};
QTEST_MAIN(CodeCopyRegressions)
#include "code_copy_regressions.moc"
