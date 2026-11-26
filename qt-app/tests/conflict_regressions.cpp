#include <QtWidgets>
#include <QtTest>
#include <QScopeGuard>
#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif
#include "bridge.h"
#include "chrome.h"
#include "document_view.h"
#include "main_window.h"
#include "source_view.h"

namespace {
// A directory link the document session must not follow: an NTFS junction on
// Windows (no privilege needed), a symbolic link elsewhere. Returns an error.
QString makeDirLink(const QString& link, const QString& target) {
#ifdef Q_OS_WIN
  auto literal = [](QString value) { return "'" + value.replace("'", "''") + "'"; };
  const QString command = "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path "
      + literal(QDir::toNativeSeparators(link)) + " -Target " + literal(QDir::toNativeSeparators(target)) + " | Out-Null";
  const QByteArray encoded(reinterpret_cast<const char*>(command.utf16()), command.size() * 2);
  QProcess process;
  process.setCreateProcessArgumentsModifier([](QProcess::CreateProcessArguments* args) {
    args->flags |= CREATE_NO_WINDOW;
  });
  const QString powershell = QDir(qEnvironmentVariable("SystemRoot"))
      .filePath("System32/WindowsPowerShell/v1.0/powershell.exe");
  process.start(powershell, {"-NoProfile", "-NonInteractive", "-EncodedCommand", QString::fromLatin1(encoded.toBase64())});
  if (!process.waitForStarted(5000)) return process.errorString();
  if (!process.waitForFinished(10000)) {
    process.kill(); process.waitForFinished(5000); return "Junction creation timed out";
  }
  if (process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0)
    return "Junction creation failed: " + QString::fromLocal8Bit(process.readAllStandardError());
  const DWORD attributes = GetFileAttributesW(reinterpret_cast<LPCWSTR>(QDir::toNativeSeparators(link).utf16()));
  if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_REPARSE_POINT))
    return "Fixture directory is not a reparse point";
  return {};
#else
  if (!QFile::link(target, link)) return "Cannot create the fixture symlink";
  if (!QFileInfo(link).isSymLink()) return "Fixture directory is not a symlink";
  return {};
#endif
}

bool removeDirLink(const QString& link) {
#ifdef Q_OS_WIN
  if (RemoveDirectoryW(reinterpret_cast<LPCWSTR>(QDir::toNativeSeparators(link).utf16()))) return true;
  qWarning() << "Cannot remove test junction" << link << GetLastError();
  return false;
#else
  if (QFile::remove(link)) return true;
  qWarning() << "Cannot remove test symlink" << link;
  return false;
#endif
}
}  // namespace

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
  static void waitIdle(MainWindow& w) {
    QElapsedTimer timer; timer.start();
    while (w.isAsyncBusy() && timer.elapsed() < 10000) {
      QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
    }
    QCoreApplication::processEvents();
  }
  static void edit(MainWindow& w, bool source) {
    if (source) {
      w.showSourceMode(); waitIdle(w); auto* view=w.findChild<SourceView*>();
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
    MainWindow w; w.show(); w.activateWindow(); QTest::qWait(20); const QString path=fixture(); w.openPath(path); waitIdle(w); edit(w,source);
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
    QFETCH(bool,source); MainWindow w;w.show();const auto path=fixture();w.openPath(path);waitIdle(w);edit(w,source);
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
    QFETCH(bool,source);MainWindow w;w.show();w.activateWindow();w.openPath(fixture());waitIdle(w);
    QWidget* editor=nullptr;
    if(source){w.showSourceMode();waitIdle(w);QTest::qWait(20);auto* v=w.findChild<SourceView*>();auto c=v->textCursor();c.setPosition(0);c.setPosition(7,QTextCursor::KeepAnchor);v->setTextCursor(c);editor=v;}
    else {auto* v=w.findChild<DocumentView*>();QVERIFY(v->revealText("body"));editor=v;}
    editor->setFocus();QCoreApplication::processEvents();w.openSearchPanel(false);
    auto* panel=w.findChild<SearchPanel*>();auto fields=panel->findChildren<QLineEdit*>();QCOMPARE(fields.size(),2);
    QVERIFY(!fields[0]->text().isEmpty()); fields[0]->setText("KEEP_QUERY");fields[0]->setFocus();
    QTest::keyClick(fields[0],Qt::Key_F,Qt::ControlModifier);QCOMPARE(fields[0]->text(),QString("KEEP_QUERY"));
    panel->setReplaceVisible(true);fields[1]->setText("OTHER_SELECTION");fields[1]->setFocus();fields[1]->selectAll();
    QTest::keyClick(fields[1],Qt::Key_F,Qt::ControlModifier);QCOMPARE(fields[0]->text(),QString("KEEP_QUERY"));
  }
  void newestQueuedOpenWaitsForConflict() {
    MainWindow w;w.show();const auto first=fixture();const auto middle=fixture("middle\n");const auto last=fixture("latest\n");w.openPath(first);waitIdle(w);edit(w,true);
    w.conflictSaveHook=[](const QString&,const QString&,const QString&){return changed("one");};
    QTimer poll;int stage=0;QElapsedTimer time;time.start();
    connect(&poll,&QTimer::timeout,&w,[&]{
      if(time.elapsed()>5000)qFatal("queue test timed out");
      if(stage==0){auto* d=conflict(w);if(!d)return;w.openPath(middle);w.openPath(last);QVERIFY(draft(w,true).contains("LOCAL"));button(d,QStringLiteral("继续编辑"))->click();stage=1;}
      else if(stage==1){for(auto* d:w.findChildren<ModalDialog*>()){if(d->isVisible()){auto* discard=button(d,QStringLiteral("放弃更改"));if(discard){discard->click();stage=2;break;}}}}
    });poll.start(5);save(w);QTRY_COMPARE_WITH_TIMEOUT(stage,2,3000);poll.stop();
    QTRY_VERIFY_WITH_TIMEOUT(w.findChild<DocumentView*>()->document()->toPlainText().contains("latest"),3000);
    QCOMPARE(w.windowTitle(),QString("Vellora"));
    w.showSourceMode();waitIdle(w);QCOMPARE(draft(w,true),QString("latest\n"));
  }
  void reloadSuccessClosesConflict() {
    MainWindow w;w.show();const auto path=fixture();w.openPath(path);waitIdle(w);edit(w,true);
    w.conflictSaveHook=[](const QString&,const QString&,const QString&){return changed("one");};
    QFile file(path);QVERIFY(file.open(QIODevice::WriteOnly));file.write("external\n");file.close();
    QTimer poll;int stage=0;
    connect(&poll,&QTimer::timeout,&w,[&]{auto* d=conflict(w);if(!d||stage)return;stage=1;
      button(d,QStringLiteral("重新加载"))->click();button(d,QStringLiteral("放弃草稿并重新加载"))->click();
    });poll.start(5);save(w);poll.stop();QCOMPARE(stage,1);QVERIFY(!conflict(w));
    w.showSourceMode();waitIdle(w);QCOMPARE(draft(w,true),QString("external\n"));QVERIFY(!w.findChild<SourceView*>()->document()->isUndoAvailable());
  }
  void staleConflictCannotInvokeAction() {
    QWidget host;host.resize(820,900);host.show();bool current=true;int calls=0;
    QTimer::singleShot(10,&host,[&]{current=false;});
    const int answer=ModalDialog::resolveConflict(&host,changed("one"),[&](bool,const QString&){++calls;return QJsonObject{{"ok",true}};},[&]{return current;});
    QVERIFY(answer!=2);QCOMPARE(calls,0);QVERIFY(!host.findChild<ModalDialog*>());
  }
  void localLinkRevalidatesAfterDiscardConfirmation() {
    QTemporaryDir tree; QVERIFY(tree.isValid());
    const QString notes = tree.filePath("notes");
    const QString sub = notes + "/sub";
    const QString originalSub = notes + "/sub-original";
    const QString outside = tree.filePath("outside");
    QVERIFY(QDir().mkpath(sub)); QVERIFY(QDir().mkpath(outside));
    const QByteArray original = "# Origin\n\nbody\n\n[go](sub/target.md)\n";
    const QByteArray insideBytes = "# Inside target\n";
    const QByteArray outsideBytes = "# Outside target\n";
    const QString origin = notes + "/origin.md";
    for (const auto& entry : {qMakePair(origin, original), qMakePair(sub + "/target.md", insideBytes),
                              qMakePair(outside + "/target.md", outsideBytes)}) {
      QFile file(entry.first); QVERIFY(file.open(QIODevice::WriteOnly));
      QCOMPARE(file.write(entry.second), qint64(entry.second.size()));
    }
    const auto openedOrigin = bridge::openDocument(origin); QVERIFY(openedOrigin.value("ok").toBool());
    const QString originSession = openedOrigin.value("document").toObject().value("path").toString();
    MainWindow w; w.show(); w.openPath(origin); waitIdle(w); edit(w, false);
    const QString local = draft(w, false);
    auto* view = w.findChild<DocumentView*>();
    QVERIFY(view->hasPendingEdits()); QVERIFY(view->document()->isUndoAvailable());
    QString junction;
    auto cleanup = qScopeGuard([&] {
      if (!junction.isEmpty()) removeDirLink(junction);
    });
    QString fixtureError;
    int stage = 0;
    QTimer poll;
    connect(&poll, &QTimer::timeout, &w, [&] {
      for (auto* dialog : w.findChildren<ModalDialog*>()) {
        if (!dialog->isVisible()) continue;
        if (stage == 0) {
          auto* discard = button(dialog, QStringLiteral("放弃更改"));
          if (!discard) continue;
          if (!QDir().rename(sub, originalSub)) {
            fixtureError = "Cannot rename the real fixture directory";
          } else {
            fixtureError = makeDirLink(sub, outside);
            if (QFileInfo(sub).isSymLink() || QFileInfo::exists(sub)) junction = sub;
            if (fixtureError.isEmpty()) {
              QFile redirected(sub + "/target.md");
              if (!redirected.open(QIODevice::ReadOnly) || redirected.readAll() != outsideBytes)
                fixtureError = "Junction did not read the isolated outside target";
            }
          }
          if (!fixtureError.isEmpty()) {
            stage = -1; button(dialog, QStringLiteral("继续编辑"))->click();
          } else { stage = 1; discard->click(); }
          return;
        }
        if (stage == 1) {
          if (auto* acknowledge = button(dialog, QStringLiteral("知道了"))) {
            stage = 2; acknowledge->click(); return;
          }
        }
      }
    });
    poll.start(5);
    emit view->linkActivated("sub/target.md");
    QVERIFY2(fixtureError.isEmpty(), qPrintable(fixtureError));
    QTRY_COMPARE_WITH_TIMEOUT(stage, 2, 5000);
    waitIdle(w); poll.stop(); QVERIFY(!w.isAsyncBusy());
    QVERIFY(bridge::sessionMatches(originSession).value("matches").toBool());
    QCOMPARE(bridge::inspectLink(originSession, "sub/target.md").value("code").toString(), QString("UNSUPPORTED_LINK"));
    QCOMPARE(draft(w, false), local);
    QVERIFY(view->hasPendingEdits()); QVERIFY(view->document()->isUndoAvailable());
    save(w);
    QFile saved(origin); QVERIFY(saved.open(QIODevice::ReadOnly)); QCOMPARE(saved.readAll(), local.toUtf8());
    for (const auto& entry : {qMakePair(originalSub + "/target.md", insideBytes), qMakePair(outside + "/target.md", outsideBytes)}) {
      QFile target(entry.first); QVERIFY(target.open(QIODevice::ReadOnly)); QCOMPARE(target.readAll(), entry.second);
    }
    QVERIFY(removeDirLink(junction));
    junction.clear();
    QVERIFY(QFileInfo::exists(outside + "/target.md"));
  }
  void newerPathSupersedesLocalLink_data() {
    QTest::addColumn<bool>("duringIme");
    QTest::newRow("discard-confirmation") << false;
    QTest::newRow("ime-wait") << true;
  }
  void newerPathSupersedesLocalLink() {
    QFETCH(bool, duringIme);
    const auto target = fixture("# Local target must not appear\n");
    const auto origin = fixture("# Origin\n\nbody\n\n[go](" + QFileInfo(target).fileName().toUtf8() + ")\n");
    const auto newer = fixture("# Newer path\n\nbody\n");
    const auto openedNewer = bridge::openDocument(newer); QVERIFY(openedNewer.value("ok").toBool());
    const QString newerSession = openedNewer.value("document").toObject().value("path").toString();
    MainWindow w; w.show(); w.openPath(origin); waitIdle(w); edit(w, false);
    auto* view = w.findChild<DocumentView*>();
    bool localApplied = false;
    connect(view->document(), &QTextDocument::contentsChanged, &w, [&] {
      if (view->document()->toPlainText().contains("Local target must not appear")) localApplied = true;
    });
    int confirmations = 0;
    QTimer poll;
    connect(&poll, &QTimer::timeout, &w, [&] {
      for (auto* dialog : w.findChildren<ModalDialog*>()) {
        if (!dialog->isVisible()) continue;
        if (auto* discard = button(dialog, QStringLiteral("放弃更改"))) {
          ++confirmations;
          if (!duringIme && confirmations == 1) w.openPath(newer);
          discard->click(); return;
        }
      }
    });
    poll.start(5);
    if (duringIme) {
      view->setFocus(); QInputMethodEvent preedit("pending", {});
      QApplication::sendEvent(view, &preedit); QVERIFY(view->isComposing());
    }
    emit view->linkActivated(QFileInfo(target).fileName());
    if (duringIme) {
      w.openPath(newer);
      QInputMethodEvent endComposition; QApplication::sendEvent(view, &endComposition);
    }
    QTRY_VERIFY_WITH_TIMEOUT(view->document()->toPlainText().contains("Newer path"), 5000);
    waitIdle(w); poll.stop(); QVERIFY(!w.isAsyncBusy());
    QCOMPARE(confirmations, duringIme ? 1 : 2);
    QVERIFY(!localApplied);
    QVERIFY(bridge::sessionMatches(newerSession).value("matches").toBool());
    QVERIFY(!view->isReadOnly());
  }
  void sourceNoopThenDeletionExhaustsOriginalMatches() {
    MainWindow w;w.show();w.openPath(fixture("a A\r\n"),true);waitIdle(w);w.openSearchPanel(true);
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
    QFETCH(QString,replacement);MainWindow w;w.show();w.openPath(fixture("a a a\r\n"),true);waitIdle(w);w.openSearchPanel(true);
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
