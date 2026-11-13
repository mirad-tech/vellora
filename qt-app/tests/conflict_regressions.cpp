#include <QtWidgets>
#include <QtTest>
#include "bridge.h"
#include "chrome.h"
#include "document_view.h"
#include "main_window.h"
#include "source_view.h"

class ConflictRegressions : public QObject {
  Q_OBJECT
  QTemporaryDir files_;
  int sequence_ = 0;
  static QPushButton* button(ModalDialog* dialog, const QString& text) {
    for (auto* b : dialog->findChildren<QPushButton*>()) if (b->text() == text) return b;
    return nullptr;
  }
  static ModalDialog* conflict(MainWindow& w) { return w.findChild<ModalDialog*>("conflictModal"); }
  QString fixture(const QByteArray& text = "# Title\n\nbody\n") {
    const QString path = files_.filePath(QString::number(++sequence_)+".md");
    QFile f(path); if (!f.open(QIODevice::WriteOnly) || f.write(text) != text.size()) qFatal("fixture write");
    return path;
  }
  static QJsonObject changed(const QString& token) {
    return {{"ok", false}, {"code", "FILE_CHANGED"}, {"message", "disk changed"}, {"conflictToken", token}};
  }
  static void edit(MainWindow& w, bool source) {
    if (source) {
      w.showSourceMode(); auto* view=w.findChild<SourceView*>();
      view->moveCursor(QTextCursor::End); QTest::keyClicks(view,"LOCAL");
    } else {
      auto* view=w.findChild<DocumentView*>(); view->revealText("body");
      QTest::keyClick(view,Qt::Key_Right); QTest::keyClicks(view,"LOCAL");
    }
  }
  static QString draft(MainWindow& w, bool source) {
    if (source) return w.findChild<SourceView*>()->toPlainText();
    QString text; w.splicePendingEdits(&text); return text;
  }
  static void save(MainWindow& w) { emit w.findChild<Toolbar*>()->saveRequested(); }
 private slots:
  void initTestCase() { QVERIFY(files_.isValid()); QApplication::setQuitOnLastWindowClosed(false); }
  void overwriteRetry_data() { QTest::addColumn<bool>("source"); QTest::newRow("document")<<false; QTest::newRow("source")<<true; }
  void overwriteRetry() {
    QFETCH(bool, source);
    MainWindow w; w.show(); w.activateWindow(); QTest::qWait(20); const QString path=fixture(); w.openPath(path); edit(w,source);
    const QString local=draft(w,source);
    int calls=0, stage=0; QPointer<ModalDialog> same; QStringList tokens;
    const QString failure=QStringLiteral("保存失败，无法自动恢复原文件。草稿已保留。备份路径：C:\\docs\\backup.md。");
    w.conflictSaveHook=[&](const QString& p,const QString& text,const QString& token) {
      ++calls; tokens<<token;
      if (QFileInfo(p).canonicalFilePath()!=QFileInfo(path).canonicalFilePath() || text!=local) { qWarning()<<p<<path<<text<<local; qFatal("stale path or draft"); }
      if (calls==1) return changed("one");
      auto* dialog=conflict(w); if (!dialog || dialog!=same) qFatal("dialog replaced");
      auto* confirm=button(dialog,QStringLiteral("确认覆盖"));
      if (!confirm || confirm->isEnabled() || button(dialog,QStringLiteral("继续编辑"))->isEnabled()) qFatal("busy buttons enabled");
      confirm->click(); save(w); QTest::keyClick(dialog,Qt::Key_Escape); dialog->close();
      if (!dialog->isVisible() || calls>4) qFatal("busy dismissal or duplicate save");
      if (calls==2) return QJsonObject{{"ok",false},{"code","SAVE_FAILED"},{"message",failure}};
      if (calls==3) return changed("two");
      return QJsonObject{{"ok",true}};
    };
    QTimer poll; QElapsedTimer time; time.start();
    connect(&poll,&QTimer::timeout,&w,[&] {
      auto* d=conflict(w); if (!d || !d->isVisible()) return;
      if (time.elapsed()>5000) qFatal("conflict test timed out");
      if (d->property("conflictBusy").toBool()) return;
      if(stage==0) {
        same=d; QCOMPARE(QApplication::focusWidget(),button(d,QStringLiteral("继续编辑")));
        button(d,QStringLiteral("覆盖外部版本"))->click();
        QCOMPARE(QApplication::focusWidget(),button(d,QStringLiteral("继续编辑")));
        button(d,QStringLiteral("确认覆盖"))->click(); stage=1;
      } else if(stage==1 && calls==2) {
        QCOMPARE(d,same.data()); auto* error=d->findChild<QLabel*>("conflictError");
        QVERIFY(error->isVisible()); QCOMPARE(error->text(),failure); QCOMPARE(draft(w,source),local);
        QVERIFY(button(d,QStringLiteral("确认覆盖"))->isEnabled());
        button(d,QStringLiteral("确认覆盖"))->click(); stage=2;
      } else if(stage==2 && calls==3) {
        QCOMPARE(d,same.data()); QVERIFY(!d->findChild<QLabel*>("conflictError")->isVisible());
        QVERIFY(!button(d,QStringLiteral("确认覆盖")));
        button(d,QStringLiteral("覆盖外部版本"))->click(); button(d,QStringLiteral("确认覆盖"))->click(); stage=3;
      }
    }); poll.start(5); save(w); poll.stop();
    QCOMPARE(stage,3); QCOMPARE(calls,4); QCOMPARE(tokens,QStringList({"","one","one","two"})); QVERIFY(!conflict(w));
    QCOMPARE(draft(w,source),local);
    QWidget* editor=source?static_cast<QWidget*>(w.findChild<SourceView*>()):w.findChild<DocumentView*>();
    QTest::keyClick(editor,Qt::Key_Z,Qt::ControlModifier); QVERIFY(draft(w,source)!=local);
  }
  void reloadFailure_data() { overwriteRetry_data(); }
  void reloadFailure() {
    QFETCH(bool,source); MainWindow w;w.show();const auto path=fixture();w.openPath(path);edit(w,source);
    const QString local=draft(w,source); int reads=0,stage=0;QPointer<ModalDialog> same;
    w.conflictSaveHook=[](const QString&,const QString&,const QString&){return changed("one");};
    w.conflictReloadHook=[&](const QString& p) {
      ++reads; if(QFileInfo(p).canonicalFilePath()!=QFileInfo(path).canonicalFilePath())qFatal("wrong reload path");
      auto* d=conflict(w); if(!d||button(d,QStringLiteral("放弃草稿并重新加载"))->isEnabled())qFatal("reload not busy");
      return QJsonObject{{"ok",false},{"code","READ_FAILED"},{"message","read failed"}};
    };
    QTimer poll;QElapsedTimer time;time.start();
    connect(&poll,&QTimer::timeout,&w,[&]{
      auto* d=conflict(w);if(!d||d->property("conflictBusy").toBool())return;
      if(time.elapsed()>5000)qFatal("reload test timed out");
      if(stage==0){same=d;button(d,QStringLiteral("重新加载"))->click();QCOMPARE(reads,0);button(d,QStringLiteral("放弃草稿并重新加载"))->click();stage=1;}
      else if(stage==1&&reads==1){QCOMPARE(d,same.data());QCOMPARE(draft(w,source),local);QCOMPARE(d->findChild<QLabel*>("conflictError")->text(),QString("read failed"));button(d,QStringLiteral("放弃草稿并重新加载"))->click();stage=2;}
      else if(stage==2&&reads==2){QCOMPARE(d,same.data());button(d,QStringLiteral("继续编辑"))->click();stage=3;}
    });poll.start(5);save(w);poll.stop();QCOMPARE(stage,3);QCOMPARE(reads,2);QCOMPARE(draft(w,source),local);
    QWidget* editor=source?static_cast<QWidget*>(w.findChild<SourceView*>()):w.findChild<DocumentView*>();
    QTest::keyClick(editor,Qt::Key_Z,Qt::ControlModifier);QVERIFY(draft(w,source)!=local);
  }
  void repeatedFindPreservesQuery_data() { overwriteRetry_data(); }
  void repeatedFindPreservesQuery() {
    QFETCH(bool,source);MainWindow w;w.show();w.activateWindow();w.openPath(fixture());
    QWidget* editor=nullptr;
    if(source){w.showSourceMode();QTest::qWait(20);auto* v=w.findChild<SourceView*>();auto c=v->textCursor();c.setPosition(0);c.setPosition(7,QTextCursor::KeepAnchor);v->setTextCursor(c);editor=v;}
    else {auto* v=w.findChild<DocumentView*>();QVERIFY(v->revealText("body"));editor=v;}
    editor->setFocus();QCoreApplication::processEvents();w.openSearchPanel(false);
    auto* panel=w.findChild<SearchPanel*>();auto fields=panel->findChildren<QLineEdit*>();QCOMPARE(fields.size(),2);
    QVERIFY(!fields[0]->text().isEmpty()); fields[0]->setText("KEEP_QUERY");fields[0]->setFocus();
    QTest::keyClick(fields[0],Qt::Key_F,Qt::ControlModifier);QCOMPARE(fields[0]->text(),QString("KEEP_QUERY"));
    panel->setReplaceVisible(true);fields[1]->setText("OTHER_SELECTION");fields[1]->setFocus();fields[1]->selectAll();
    QTest::keyClick(fields[1],Qt::Key_F,Qt::ControlModifier);QCOMPARE(fields[0]->text(),QString("KEEP_QUERY"));
  }
  void newestQueuedOpenWaitsForConflict() {
    MainWindow w;w.show();const auto first=fixture();const auto middle=fixture("middle\n");const auto last=fixture("latest\n");w.openPath(first);edit(w,true);
    w.conflictSaveHook=[](const QString&,const QString&,const QString&){return changed("one");};
    QTimer poll;int stage=0;QElapsedTimer time;time.start();
    connect(&poll,&QTimer::timeout,&w,[&]{
      if(time.elapsed()>5000)qFatal("queue test timed out");
      if(stage==0){auto* d=conflict(w);if(!d)return;w.openPath(middle);w.openPath(last);QVERIFY(draft(w,true).contains("LOCAL"));button(d,QStringLiteral("继续编辑"))->click();stage=1;}
      else if(stage==1){for(auto* d:w.findChildren<ModalDialog*>()){if(d->isVisible()){auto* discard=button(d,QStringLiteral("放弃更改"));if(discard){discard->click();stage=2;break;}}}}
    });poll.start(5);save(w);QTRY_COMPARE_WITH_TIMEOUT(stage,2,3000);poll.stop();
    QTRY_VERIFY_WITH_TIMEOUT(w.findChild<DocumentView*>()->document()->toPlainText().contains("latest"),3000);
    QCOMPARE(w.windowTitle(),QString("Vellora"));
    w.showSourceMode();QCOMPARE(draft(w,true),QString("latest\n"));
  }
  void reloadSuccessClosesConflict() {
    MainWindow w;w.show();const auto path=fixture();w.openPath(path);edit(w,true);
    w.conflictSaveHook=[](const QString&,const QString&,const QString&){return changed("one");};
    QFile file(path);QVERIFY(file.open(QIODevice::WriteOnly));file.write("external\n");file.close();
    QTimer poll;int stage=0;
    connect(&poll,&QTimer::timeout,&w,[&]{auto* d=conflict(w);if(!d||stage)return;stage=1;
      button(d,QStringLiteral("重新加载"))->click();button(d,QStringLiteral("放弃草稿并重新加载"))->click();
    });poll.start(5);save(w);poll.stop();QCOMPARE(stage,1);QVERIFY(!conflict(w));
    w.showSourceMode();QCOMPARE(draft(w,true),QString("external\n"));QVERIFY(!w.findChild<SourceView*>()->document()->isUndoAvailable());
  }
  void staleConflictCannotInvokeAction() {
    QWidget host;host.resize(820,900);host.show();bool current=true;int calls=0;
    QTimer::singleShot(10,&host,[&]{current=false;});
    const int answer=ModalDialog::resolveConflict(&host,changed("one"),[&](bool,const QString&){++calls;return QJsonObject{{"ok",true}};},[&]{return current;});
    QVERIFY(answer!=2);QCOMPARE(calls,0);QVERIFY(!host.findChild<ModalDialog*>());
  }
  void sourceNoopThenDeletionExhaustsOriginalMatches() {
    MainWindow w;w.show();w.openPath(fixture("a A\r\n"));w.showSourceMode();w.openSearchPanel(true);
    auto* search=w.findChild<SearchPanel*>();auto fields=search->findChildren<QLineEdit*>();fields[0]->setText("a");fields[1]->setText("a");
    auto* source=w.findChild<SourceView*>();emit search->replaceRequested();QCOMPARE(source->toPlainText(),QString("a A\n"));QVERIFY(!source->document()->isUndoAvailable());
    fields[1]->setText("");emit search->replaceRequested();QCOMPARE(source->toPlainText(),QString("a \n"));
    emit search->replaceRequested();QCOMPARE(source->toPlainText(),QString("a \n"));
    QString saved;w.conflictSaveHook=[&](const QString&,const QString& text,const QString&){saved=text;return QJsonObject{{"ok",true}};};save(w);QCOMPARE(saved,QString("a \r\n"));
    QTest::keyClick(source,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(source->toPlainText(),QString("a A\n"));
  }
  void sourceReplacementExhaustion_data() {
    QTest::addColumn<QString>("replacement");QTest::newRow("growth")<<QString("aa");QTest::newRow("no-op")<<QString("a");
  }
  void sourceReplacementExhaustion() {
    QFETCH(QString,replacement);MainWindow w;w.show();w.openPath(fixture("a a a\r\n"));w.showSourceMode();w.openSearchPanel(true);
    auto* search=w.findChild<SearchPanel*>();auto fields=search->findChildren<QLineEdit*>();QCOMPARE(fields.size(),2);
    fields[0]->setText("a");fields[1]->setText(replacement);auto* source=w.findChild<SourceView*>();
    for(int i=0;i<3;++i)emit search->replaceRequested();
    const QString expected=replacement+" "+replacement+" "+replacement+"\n";
    QCOMPARE(source->toPlainText(),expected);emit search->replaceRequested();QCOMPARE(source->toPlainText(),expected);
    if(replacement=="a")QVERIFY(!source->document()->isUndoAvailable());
    else {QTest::keyClick(source,Qt::Key_Z,Qt::ControlModifier);QCOMPARE(source->toPlainText(),QString("aa aa a\n"));}
  }
};
QTEST_MAIN(ConflictRegressions)
#include "conflict_regressions.moc"
