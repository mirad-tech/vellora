#include <QtTest>
#include <QAccessible>
#include <QApplication>
#include <QLineEdit>
#include <QPushButton>
#include <QToolButton>
#include "chrome.h"

class ChromeAccessibilityRegressions : public QObject {
  Q_OBJECT
  static QLineEdit* input(SearchPanel& panel,const QString& name) {
    for(auto* field:panel.findChildren<QLineEdit*>()) if(field->accessibleName()==name)return field;
    return nullptr;
  }
  static QToolButton* button(QWidget& widget,const QString& name) {
    for(auto* control:widget.findChildren<QToolButton*>()) if(control->accessibleName()==name)return control;
    return nullptr;
  }
 private slots:
  void replaceShortcutFocusPreservesQuery() {
    SearchPanel panel;panel.openWith(false,"needle");panel.activateWindow();
    auto* query=input(panel,QStringLiteral("搜索当前文档"));auto* replacement=input(panel,QStringLiteral("替换为"));
    QVERIFY(query);QVERIFY(replacement);query->setFocus();
    panel.openWith(true);QTRY_VERIFY(replacement->hasFocus());
    QTest::keyClicks(replacement,"new value");QCOMPARE(panel.query(),QString("needle"));QCOMPARE(panel.replacement(),QString("new value"));
    panel.openWith(false);QTRY_VERIFY(query->hasFocus());
    panel.openWith(true);QTRY_VERIFY(replacement->hasFocus());QCOMPARE(replacement->cursorPosition(),QString("new value").size());
  }
  void emptyReplacementShortcutFocusesQuery() {
    SearchPanel panel;panel.openWith(true);panel.activateWindow();
    auto* query=input(panel,QStringLiteral("搜索当前文档"));QVERIFY(query);query->setFocus();
    panel.openWith(true);QTRY_VERIFY(query->hasFocus());
    query->setText("   ");panel.openWith(true);QVERIFY(query->hasFocus());
    panel.openWith(true,"selected text");QTRY_VERIFY(input(panel,QStringLiteral("替换为"))->hasFocus());
  }
  void iconControlsExposeExactNamesAndStates() {
    Toolbar toolbar;toolbar.setDocumentAvailable(true);toolbar.show();
    for(const auto& name:{QStringLiteral("查找"),QStringLiteral("目录"),QStringLiteral("打开文件"),QStringLiteral("保存")}) {
      auto* control=button(toolbar,name);QVERIFY2(control,qPrintable(name));
      auto* ax=QAccessible::queryAccessibleInterface(control);QVERIFY(ax);QCOMPARE(ax->text(QAccessible::Name),name);
    }
    SearchPanel panel;panel.openWith(false,"needle");panel.setCounter(1,2);
    for(const auto& name:{QStringLiteral("关闭查找"),QStringLiteral("上一个匹配项"),QStringLiteral("下一个匹配项"),QStringLiteral("展开替换")}) {
      auto* control=button(panel,name);QVERIFY2(control,qPrintable(name));
      auto* ax=QAccessible::queryAccessibleInterface(control);QVERIFY(ax);QCOMPARE(ax->text(QAccessible::Name),name);
    }
    panel.setReplaceVisible(true);QVERIFY(button(panel,QStringLiteral("收起替换")));
    panel.setReplaceVisible(false);QVERIFY(button(panel,QStringLiteral("展开替换")));
    OutlinePanel outline;auto* close=button(outline,QStringLiteral("关闭目录"));QVERIFY(close);
    QCOMPARE(QAccessible::queryAccessibleInterface(close)->text(QAccessible::Name),QStringLiteral("关闭目录"));
  }
  void modesHaveIndependentAccessibleActions() {
    SegmentedControl modes;modes.show();modes.activateWindow();
    const auto children=modes.findChildren<QPushButton*>(QString(),Qt::FindDirectChildrenOnly);QCOMPARE(children.size(),2);
    auto* document=QAccessible::queryAccessibleInterface(children[0]);auto* source=QAccessible::queryAccessibleInterface(children[1]);
    QVERIFY(document);QVERIFY(source);QCOMPARE(document->text(QAccessible::Name),QStringLiteral("文档"));QCOMPARE(source->text(QAccessible::Name),QStringLiteral("源码"));
    QVERIFY(document->state().checked);QVERIFY(!source->state().checked);QVERIFY(source->actionInterface());
    QSignalSpy changed(&modes,&SegmentedControl::currentChanged);
    source->actionInterface()->doAction(QAccessibleActionInterface::pressAction());
    QTRY_COMPARE(modes.current(),1);QCOMPARE(changed.count(),1);QVERIFY(source->state().checked);QVERIFY(!document->state().checked);
    children[1]->setFocus();QTest::keyClick(children[1],Qt::Key_Left);QCOMPARE(modes.current(),0);QVERIFY(children[0]->hasFocus());
    children[1]->setFocus();QTest::keyClick(children[1],Qt::Key_Space);QCOMPARE(modes.current(),1);
    children[0]->setFocus();QTest::keyClick(children[0],Qt::Key_Return);QCOMPARE(modes.current(),0);
    modes.setEnabled(false);QVERIFY(document->state().disabled);QVERIFY(source->state().disabled);
  }
  void modeFocusDoesNotAlterPaint() {
    SegmentedControl modes;modes.show();modes.activateWindow();QTest::qWait(20);
    const auto children=modes.findChildren<QPushButton*>(QString(),Qt::FindDirectChildrenOnly);
    children[0]->setFocus();const auto before=modes.grab().toImage();
    children[1]->setFocus();const auto after=modes.grab().toImage();
    QCOMPARE(before,after);QCOMPARE(modes.size(),QSize(114,32));
  }
};
QTEST_MAIN(ChromeAccessibilityRegressions)
#include "chrome_accessibility_regressions.moc"
