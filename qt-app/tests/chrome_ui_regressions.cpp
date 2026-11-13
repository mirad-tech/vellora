#include <QtWidgets>
#include <QtTest>
#include "chrome.h"

class ChromeUiRegressions : public QObject {
  Q_OBJECT
  static ModalDialog* visibleDialog(QWidget& host) {
    for (auto* d : host.findChildren<ModalDialog*>()) if (d->isVisible()) return d;
    return nullptr;
  }
  static void clickInside(ModalDialog* dialog) {
    QTest::mouseClick(dialog, Qt::LeftButton, Qt::NoModifier, QPoint(20, dialog->height()/2));
    QTest::mouseClick(dialog->findChild<QLabel*>("title"), Qt::LeftButton);
    QTest::mouseClick(dialog->findChild<QLabel*>("message"), Qt::LeftButton);
    auto* scroll = dialog->findChild<QScrollArea*>("modalBodyScroll");
    QTest::mouseClick(scroll->viewport(), Qt::LeftButton, Qt::NoModifier, QPoint(2,2));
  }
 private slots:
  void cleanup() { qApp->setProperty("velloraTestSurfaceMotion", QVariant()); QCoreApplication::sendPostedEvents(nullptr,QEvent::DeferredDelete); }
  void normalCardClicksStayOpenBackdropCancels() {
    QWidget host;host.resize(820,900);host.show();bool checked=false;bool remained=false;
    QTimer watchdog;watchdog.setSingleShot(true);connect(&watchdog,&QTimer::timeout,&host,[&]{if(auto* d=visibleDialog(host))d->close();});watchdog.start(2000);
    QTimer::singleShot(30,&host,[&]{
      auto* d=visibleDialog(host);if(!d)return;QSignalSpy finished(d,&ModalDialog::finished);
      clickInside(d);remained=d->isVisible()&&finished.count()==0;checked=true;
      QTest::mouseClick(d->parentWidget(),Qt::LeftButton,Qt::NoModifier,QPoint(4,4));
    });
    QCOMPARE(ModalDialog::ask(&host,QStringLiteral("未保存更改"),QStringLiteral("当前文档有未保存更改。"),QStringLiteral("放弃更改"),QStringLiteral("继续编辑")),1);
    QVERIFY(checked);QVERIFY(remained);QVERIFY(watchdog.isActive());
  }
  void conflictCardAndBackdropStayOpen() {
    QWidget host;host.resize(820,900);host.show();bool checked=false,remained=false;int calls=0;
    QTimer watchdog;watchdog.setSingleShot(true);connect(&watchdog,&QTimer::timeout,&host,[&]{if(auto* d=visibleDialog(host))d->close();});watchdog.start(2000);
    QTimer::singleShot(30,&host,[&]{auto* d=visibleDialog(host);if(!d)return;QSignalSpy finished(d,&ModalDialog::finished);
      clickInside(d);QTest::mouseClick(d->parentWidget(),Qt::LeftButton,Qt::NoModifier,QPoint(4,4));
      remained=d->isVisible()&&finished.count()==0;checked=true;QTest::keyClick(d,Qt::Key_Escape);
    });
    ModalDialog::resolveConflict(&host,{{"message","Changed"},{"conflictToken","one"}},[&](bool,const QString&){++calls;return QJsonObject();},[]{return true;});
    QVERIFY(checked);QVERIFY(remained);QCOMPARE(calls,0);QVERIFY(watchdog.isActive());
  }
  void shortMessagesHaveIdenticalFinalSize() {
    QWidget host;host.resize(820,900);host.show();QSize expected;
    for(const QString& text : {QStringLiteral("当前文档有未保存更改。"),QStringLiteral("将替换当前文档中 1 处内容。"),QStringLiteral("将替换当前文档中 12345 处内容。")}) {
      ModalDialog dialog(&host,QStringLiteral("全部替换"),text,QStringLiteral("全部替换"),QStringLiteral("取消"));dialog.show();dialog.fitToParent();
      if(expected.isEmpty())expected=dialog.size();QCOMPARE(dialog.size(),expected);QCOMPARE(dialog.width(),440);
      auto* label=dialog.findChild<QLabel*>("message");QVERIFY(label->height()>=label->heightForWidth(label->width()));
    }
  }
  void conflictChoiceShrinksToSingleLineConfirmation() {
    QWidget host;host.resize(820,900);host.show();
    ModalDialog reference(&host,QStringLiteral("文件已被外部修改"),QStringLiteral("确认用当前草稿覆盖检测到的外部版本？"),QStringLiteral("确认覆盖"),QStringLiteral("继续编辑"),true);
    reference.fitToParent();const QSize expected=reference.size();bool checked=false,shrunk=false,resized=false;
    QTimer watchdog;watchdog.setSingleShot(true);connect(&watchdog,&QTimer::timeout,&host,[&]{if(auto* d=visibleDialog(host))d->close();});watchdog.start(2000);
    QTimer::singleShot(30,&host,[&]{auto* d=visibleDialog(host);if(!d)return;const int initial=d->height();
      for(auto* b:d->findChildren<QPushButton*>())if(b->text()==QStringLiteral("覆盖外部版本")){b->click();break;}
      shrunk=d->height()<initial&&d->size()==expected;
      host.resize(320,900);QCoreApplication::processEvents();const int narrow=d->height();
      host.resize(820,900);QCoreApplication::processEvents();resized=d->size()==expected&&d->height()<narrow;checked=true;d->close();
    });
    ModalDialog::resolveConflict(&host,{{"message",QStringLiteral("文件内容已被外部修改。\n继续前请选择处理方式。")},{"conflictToken","one"}},[](bool,const QString&){return QJsonObject();},[]{return true;});
    QVERIFY(checked);QVERIFY(shrunk);QVERIFY(resized);QVERIFY(watchdog.isActive());
  }
  void titleAndBodyRemeasureAfterShorteningAndWidening() {
    QWidget host;host.resize(320,900);host.show();
    ModalDialog d(&host,QStringLiteral("很长的标题用于检查窄窗口换行后重新测量高度"),QStringLiteral("较长的消息用于检查正文换行和滚动，之后必须恢复正常高度。").repeated(30),QStringLiteral("确认"),QStringLiteral("取消"));
    d.show();d.fitToParent();QCoreApplication::processEvents();const int narrow=d.height();
    host.resize(820,900);d.fitToParent();QCoreApplication::processEvents();
    d.findChild<QLabel*>("title")->setText(QStringLiteral("标题"));d.findChild<QLabel*>("message")->setText(QStringLiteral("一行正文。"));d.fitToParent();QCoreApplication::processEvents();
    ModalDialog fresh(&host,QStringLiteral("标题"),QStringLiteral("一行正文。"),QStringLiteral("确认"),QStringLiteral("取消"));fresh.fitToParent();
    QCOMPARE(d.size(),fresh.size());QVERIFY(d.height()<narrow);QCOMPARE(d.findChild<QScrollArea*>("modalBodyScroll")->verticalScrollBar()->maximum(),0);
    QCOMPARE(d.findChild<QLabel*>("title")->height(),fresh.findChild<QLabel*>("title")->height());
    QCOMPARE(d.findChild<QLabel*>("message")->height(),fresh.findChild<QLabel*>("message")->height());
  }
  void longTextIsScrollableWithoutClipping_data() {
    QTest::addColumn<QSize>("size");QTest::newRow("normal")<<QSize(820,900);QTest::newRow("small")<<QSize(320,280);
  }
  void longTextIsScrollableWithoutClipping() {
    QFETCH(QSize,size);QWidget host;host.resize(size);host.show();
    ModalDialog d(&host,QStringLiteral("文件已被外部修改"),QStringLiteral("读取失败，草稿已保留。长路径 C:/documents/some-long-backup-name.md。\n").repeated(40),QStringLiteral("确认覆盖"),QStringLiteral("继续编辑"));
    d.show();d.fitToParent();QCoreApplication::processEvents();
    QVERIFY(host.rect().contains(d.geometry()));auto* area=d.findChild<QScrollArea*>("modalBodyScroll");QVERIFY(area);
    QVERIFY(area->verticalScrollBar()->maximum()>0);auto* label=d.findChild<QLabel*>("message");
    QVERIFY(label->height()>=label->heightForWidth(label->width()));area->verticalScrollBar()->setValue(area->verticalScrollBar()->maximum());
    QVERIFY(area->verticalScrollBar()->value()>0);
    auto* bar=area->verticalScrollBar();QCOMPARE(bar->width(),10);QCOMPARE(bar->sizeHint().width(),10);
    QCOMPARE(area->frameShape(),QFrame::NoFrame);
    QStyleOptionSlider option;option.initFrom(bar);option.orientation=Qt::Vertical;
    option.minimum=bar->minimum();option.maximum=bar->maximum();option.pageStep=bar->pageStep();
    QCOMPARE(bar->style()->subControlRect(QStyle::CC_ScrollBar,&option,QStyle::SC_ScrollBarAddLine,bar).height(),0);
    QCOMPARE(bar->style()->subControlRect(QStyle::CC_ScrollBar,&option,QStyle::SC_ScrollBarSubLine,bar).height(),0);
    QVERIFY(label->width()<=area->viewport()->width());
    for(auto* button:d.findChildren<QPushButton*>())QVERIFY(d.rect().contains(QRect(button->mapTo(&d,QPoint()),button->size())));
  }
  void longConflictFailureUsesSameScrollableBody() {
    QWidget host;host.resize(400,300);host.show();bool checked=false,scrolls=false;int stage=0;
    QTimer watchdog;watchdog.setSingleShot(true);connect(&watchdog,&QTimer::timeout,&host,[&]{if(auto* d=visibleDialog(host))d->close();});watchdog.start(2000);
    QTimer poll;connect(&poll,&QTimer::timeout,&host,[&]{auto* d=visibleDialog(host);if(!d||d->property("conflictBusy").toBool())return;
      QPushButton* action=nullptr;for(auto* b:d->findChildren<QPushButton*>())if(b->property("primary").toBool())action=b;
      if(stage<2){++stage;action->click();return;}
      auto* error=d->findChild<QLabel*>("conflictError");if(error->isHidden())return;
      auto* area=d->findChild<QScrollArea*>("modalBodyScroll");scrolls=area->verticalScrollBar()->maximum()>0&&host.rect().contains(d->geometry())&&error->height()>=error->heightForWidth(error->width());checked=true;d->close();
    });poll.start(10);
    ModalDialog::resolveConflict(&host,{{"message","Changed"},{"conflictToken","one"}},[](bool,const QString&){return QJsonObject{{"ok",false},{"code","SAVE_FAILED"},{"message",QStringLiteral("保存失败，草稿和备份已保留。\n").repeated(80)}};},[]{return true;});
    QVERIFY(checked);QVERIFY(scrolls);QVERIFY(watchdog.isActive());
  }
  void longBodyScrollsFromButtonFocusWithoutChangingDecisions() {
    QWidget host;host.resize(400,300);host.show();host.activateWindow();
    ModalDialog d(&host,QStringLiteral("文件已被外部修改"),QStringLiteral("读取失败，草稿已保留。\n").repeated(80),QStringLiteral("确认覆盖"),QStringLiteral("继续编辑"));
    d.show();d.fitToParent();QCoreApplication::processEvents();
    auto* bar=d.findChild<QScrollArea*>("modalBodyScroll")->verticalScrollBar();QVERIFY(bar->maximum()>0);
    auto* cancel=d.findChildren<QPushButton*>().first();cancel->setFocus();QSignalSpy finished(&d,&ModalDialog::finished);
    QTest::keyClick(cancel,Qt::Key_PageDown);QVERIFY(bar->value()>0);QCOMPARE(finished.count(),0);
    QTest::keyClick(cancel,Qt::Key_Home);QCOMPARE(bar->value(),0);
    QTest::keyClick(cancel,Qt::Key_Down);QVERIFY(bar->value()>0);
    QTest::keyClick(cancel,Qt::Key_Up);QCOMPARE(bar->value(),0);
    QTest::keyClick(cancel,Qt::Key_End);QCOMPARE(bar->value(),bar->maximum());
    QTest::keyClick(cancel,Qt::Key_PageUp);QVERIFY(bar->value()<bar->maximum());
    QCOMPARE(QApplication::focusWidget(),cancel);QCOMPARE(finished.count(),0);
    QTest::keyClick(cancel,Qt::Key_Return);QCOMPARE(finished.count(),1);QVERIFY(!d.isVisible());
    d.show();cancel->setFocus();QTest::keyClick(cancel,Qt::Key_Escape);QCOMPARE(finished.count(),2);QVERIFY(!d.isVisible());
  }
  void replacementHeightAnimatesAndReverses() {
    qApp->setProperty("velloraTestSurfaceMotion",true);QWidget host;host.resize(820,600);host.show();SearchPanel panel(&host);panel.openWith(false,"a");QTest::qWait(230);
    auto* row=panel.findChild<QWidget*>("replacementRow");auto* animation=panel.findChild<QVariantAnimation*>("searchReplacementAnimation");QVERIFY(row);QVERIFY(animation);QCOMPARE(animation->duration(),200);
    const int collapsed=panel.height();panel.setReplaceVisible(true);QCOMPARE(animation->state(),QAbstractAnimation::Running);
    animation->setCurrentTime(40);const int middle=row->height();QVERIFY(middle>0&&middle<40);QVERIFY(panel.height()>collapsed&&panel.height()<collapsed+40);
    panel.setReplaceVisible(false);QCOMPARE(animation->startValue().toInt(),middle);animation->setCurrentTime(25);QVERIFY(row->height()<middle);
    panel.setReplaceVisible(true);QTRY_COMPARE_WITH_TIMEOUT(animation->state(),QAbstractAnimation::Stopped,1000);QCOMPARE(row->height(),40);QVERIFY(row->isVisible());
    panel.setReplaceVisible(false);QTRY_COMPARE_WITH_TIMEOUT(animation->state(),QAbstractAnimation::Stopped,1000);QVERIFY(row->isHidden());QCOMPARE(panel.height(),collapsed);
    QVERIFY(!row->graphicsEffect());
  }
  void replacementCloseReopenAndIme() {
    qApp->setProperty("velloraTestSurfaceMotion",true);QWidget host;host.resize(820,600);host.show();SearchPanel panel(&host);panel.openWith(false,"a");
    auto* animation=panel.findChild<QVariantAnimation*>("searchReplacementAnimation");auto* row=panel.findChild<QWidget*>("replacementRow");
    panel.setReplaceVisible(true);animation->setCurrentTime(40);panel.closePanel();QCOMPARE(animation->state(),QAbstractAnimation::Stopped);
    panel.openWith(true);QCOMPARE(row->height(),40);QVERIFY(row->isVisible());auto* input=row->findChild<QLineEdit*>();input->setFocus();
    QInputMethodEvent composing(QStringLiteral("拼"),{});QCoreApplication::sendEvent(input,&composing);panel.setReplaceVisible(false);QVERIFY(panel.isReplaceMode());QVERIFY(row->isVisible());
    QInputMethodEvent commit;commit.setCommitString(QStringLiteral("拼"));QCoreApplication::sendEvent(input,&commit);QCOMPARE(input->text(),QStringLiteral("拼"));
    panel.setReplaceVisible(false);panel.closePanel();panel.openWith(false);QVERIFY(row->isHidden());QCOMPARE(animation->state(),QAbstractAnimation::Stopped);
  }
  void replacementDisabledMotionIsImmediate() {
    qApp->setProperty("velloraTestSurfaceMotion",false);QWidget host;host.show();SearchPanel panel(&host);panel.openWith(false);
    auto* row=panel.findChild<QWidget*>("replacementRow");auto* animation=panel.findChild<QVariantAnimation*>("searchReplacementAnimation");
    panel.setReplaceVisible(true);QCOMPARE(row->height(),40);QCOMPARE(animation->state(),QAbstractAnimation::Stopped);
    panel.setReplaceVisible(false);QVERIFY(row->isHidden());QCOMPARE(animation->state(),QAbstractAnimation::Stopped);
  }
};
QTEST_MAIN(ChromeUiRegressions)
#include "chrome_ui_regressions.moc"
