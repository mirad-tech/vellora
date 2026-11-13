#include <QtWidgets>
#include <QtTest>
#include "bridge.h"
#include "document_view.h"

class SerializationRegressions : public QObject {
  Q_OBJECT
  static QString save(const QString& original, const DocumentView& view) {
    QJsonArray edits;
    for (const auto& edit : view.pendingEdits())
      edits.append(QJsonObject{{"index", edit.first}, {"markdown", edit.second}});
    const auto result = bridge::spliceSegments(original, edits);
    if (!result.value("ok").toBool() || result.value("applied").toInt(-1) != edits.size()) return {};
    return result.value("content").toString();
  }
  static void load(DocumentView& view, const QString& original) {
    view.resize(820, 900);
    view.setPlan(bridge::planFor(original).value("plan").toObject(), QString());
    view.show(); view.setFocus();
    QCoreApplication::processEvents();
  }
  static void insert(DocumentView& view, const QString& text) {
    QInputMethodEvent event; event.setCommitString(text);
    QApplication::sendEvent(&view, &event);
    QCoreApplication::processEvents();
  }
  static QString paragraphText(const QJsonObject& node) {
    QString text;
    for (const auto& run : node.value("runs").toArray()) text += run.toObject().value("text").toString();
    return text;
  }
 private slots:
  void paragraphPrefixes_data() {
    QTest::addColumn<QString>("text");
    QTest::newRow("four-spaces") << QString("    indented text");
    QTest::newRow("tab") << QString("\tindented text");
    QTest::newRow("mixed-indent") << QString(" \t  indented text");
    QTest::newRow("ordered") << QString("1. literal list");
    QTest::newRow("ordered-paren") << QString("9) literal list");
    QTest::newRow("rule") << QString("---");
    QTest::newRow("heading") << QString("# literal heading");
    QTest::newRow("quote") << QString("> literal quote");
    QTest::newRow("table-marker") << QString("| A | B |");
    QTest::newRow("three-space-list") << QString("   1. literal list");
  }
  void paragraphPrefixes() {
    QFETCH(QString, text);
    const QString original = QStringLiteral("seed\n\nTail\n");
    DocumentView view; load(view, original); QVERIFY(view.revealText("seed")); insert(view, text);
    const QString saved = save(original, view); QVERIFY(!saved.isEmpty());
    const auto blocks = bridge::planFor(saved).value("plan").toObject().value("blocks").toArray();
    QCOMPARE(blocks.size(), 2);
    QCOMPARE(blocks.first().toObject().value("type").toString(), QString("paragraph"));
    QCOMPARE(paragraphText(blocks.first().toObject()), text);
    QVERIFY(saved.endsWith("\n\nTail\n"));
    QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier); QCOMPARE(save(original, view), original);
  }
  void structuralSplitPrefixes_data() { paragraphPrefixes_data(); }
  void structuralSplitPrefixes() {
    QFETCH(QString, text);
    const QString original = QStringLiteral("prefixsuffix\n\nTail\n");
    DocumentView view; load(view, original); QVERIFY(view.revealText("prefix"));
    QTest::keyClick(&view, Qt::Key_Right); QTest::keyClick(&view, Qt::Key_Return);
    QVERIFY(view.revealText("suffix")); insert(view, text);
    const QString saved = save(original, view); QVERIFY(!saved.isEmpty());
    const auto blocks = bridge::planFor(saved).value("plan").toObject().value("blocks").toArray();
    QCOMPARE(blocks.size(), 3);
    QCOMPARE(blocks.at(1).toObject().value("type").toString(), QString("paragraph"));
    QCOMPARE(paragraphText(blocks.at(1).toObject()), text);
    QVERIFY(saved.endsWith("\n\nTail\n"));
    QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier);
    QTest::keyClick(&view, Qt::Key_Z, Qt::ControlModifier); QCOMPARE(save(original, view), original);
  }
  void multilineHardBreakCannotBecomeTable() {
    const QString original = QStringLiteral("seed\n\nTail\n");
    DocumentView view; load(view, original); QVERIFY(view.revealText("seed")); insert(view, "| A | B |");
    QTest::keyClick(&view, Qt::Key_Return, Qt::ControlModifier); insert(view, ":--- | ---:");
    const QString saved = save(original, view);
    const auto blocks = bridge::planFor(saved).value("plan").toObject().value("blocks").toArray();
    QCOMPARE(blocks.size(), 2); QCOMPARE(blocks.first().toObject().value("type").toString(), QString("paragraph"));
    QVERIFY(saved.contains("\\| A | B |  \n\\:--- | ---:"));
    DocumentView reopened; load(reopened, saved);
    QVERIFY(reopened.document()->toPlainText().contains("| A | B |\n:--- | ---:"));
  }
};
QTEST_MAIN(SerializationRegressions)
#include "serialization_regressions.moc"
