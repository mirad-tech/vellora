#include <QApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QIcon>
#include <QLineEdit>
#include <QLocalServer>
#include <QLocalSocket>
#include <QTextStream>
#include <QScreen>
#include <QTimer>

#include "chrome.h"
#include "document_view.h"
#include "main_window.h"
#include "source_view.h"
#include "theme.h"

int main(int argc, char** argv) {
  QApplication app(argc, argv);
  app.setApplicationName(QStringLiteral("Vellora"));
  app.setApplicationDisplayName(QStringLiteral("Vellora"));
  app.setApplicationVersion(QStringLiteral("0.1.2"));
  app.setOrganizationName(QStringLiteral("Vellora Contributors"));
  app.setFont(theme::uiFont(14));
  app.setStyle(QStringLiteral("Fusion"));
  app.setPalette(theme::selectionPalette(app.palette()));
  app.setWindowIcon(QIcon(QStringLiteral(":/vellora/icon.ico")));
  const QStringList args = app.arguments();
  QString initialPath;
  for (int i = 1; i < args.size(); ++i) {
    const QString candidate = args.at(i);
    if (candidate.startsWith('-')) continue;
    const QString lower = candidate.toLower();
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
      initialPath = QFileInfo(candidate).absoluteFilePath();
      break;
    }
  }
  const bool initialSource = args.contains(QStringLiteral("--source")) || args.contains(QStringLiteral("--source-mode"));
  // Qt Preview has a per-user endpoint independent from the existing Tauri app.
  QString identity = QDir::homePath();
#ifdef VELLORA_ENABLE_TEST_HOOKS
  identity += qEnvironmentVariable("VELLORA_TEST_INSTANCE");
#endif
  const QString serverName = QStringLiteral("vellora.qt.preview.") +
      QString::fromLatin1(QCryptographicHash::hash(identity.toUtf8(), QCryptographicHash::Sha256).toHex().left(24));
  const QByteArray request = QJsonDocument(QJsonObject{{"path", initialPath}, {"source", initialSource}}).toJson(QJsonDocument::Compact) + '\n';
  auto forwardToExisting = [&]() {
    QLocalSocket socket;
    socket.connectToServer(serverName);
    if (!socket.waitForConnected(250)) return false;
    if (socket.write(request) != request.size()) return false;
    if (socket.bytesToWrite() > 0 && !socket.waitForBytesWritten(1000)) return false;
    socket.disconnectFromServer();
    return true;
  };
  if (forwardToExisting()) return 0;
  QLocalServer server;
  server.setSocketOptions(QLocalServer::UserAccessOption);
  if (!server.listen(serverName)) {
    // A concurrent launch may win the race. Never remove a live endpoint.
    if (forwardToExisting()) return 0;
    qCritical("Unable to create the Vellora single-instance endpoint.");
    return 1;
  }

  MainWindow window;
  QObject::connect(&server, &QLocalServer::newConnection, &window, [&] {
    while (auto* socket = server.nextPendingConnection()) {
      QObject::connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
      auto consume = [socket, &window] {
        const QByteArray buffered = socket->property("requestBytes").toByteArray() + socket->readAll();
        if (buffered.size() > 64 * 1024) { socket->abort(); return; }
        const int end = buffered.indexOf('\n');
        if (end < 0) { socket->setProperty("requestBytes", buffered); return; }
        const QJsonDocument message = QJsonDocument::fromJson(buffered.left(end));
        if (!message.isObject()) { socket->abort(); return; }
        const QJsonObject object = message.object();
        const QString path = object.value("path").toString();
        if (window.isMinimized()) window.showNormal();
        else window.show();
        window.raise();
        window.activateWindow();
        if (!path.isEmpty() && QFileInfo(path).isAbsolute() &&
            (path.endsWith(".md", Qt::CaseInsensitive) || path.endsWith(".markdown", Qt::CaseInsensitive))) {
          window.openPath(path, object.value("source").toBool());
        }
        socket->disconnectFromServer();
      };
      QObject::connect(socket, &QLocalSocket::readyRead, &window, consume);
      if (socket->bytesAvailable()) consume();
      QTimer::singleShot(2000, socket, [socket] { socket->disconnectFromServer(); });
    }
  });
  window.show();

#ifdef VELLORA_ENABLE_TEST_HOOKS
  // Metadata-only observation for isolated automated performance runs. No
  // document text or state is exported in an ordinary application launch.
  if (!qEnvironmentVariable("VELLORA_TEST_INSTANCE").isEmpty() &&
      !qEnvironmentVariable("VELLORA_TEST_OBSERVE").isEmpty()) {
    auto* observer = new QTimer(&window);
    observer->setInterval(250);
    const QString outputPath = qEnvironmentVariable("VELLORA_TEST_OBSERVE");
    QObject::connect(observer, &QTimer::timeout, &window,
        [&window, outputPath, previous = QByteArray()]() mutable {
      auto* source = window.findChild<SourceView*>();
      auto* document = window.findChild<DocumentView*>();
      auto* search = window.findChild<SearchPanel*>();
      QScreen* screen = window.screen();
      const QJsonObject state{{"title", window.windowTitle()},
                             {"sourceVisible", source && source->isVisible()},
                             {"documentChars", document ? document->document()->characterCount() : 0},
                             {"searchVisible", search && search->isVisible()},
                             {"searchMatches", document ? document->searchMatchCount() : 0},
                             {"qtVersion", QString::fromLatin1(qVersion())},
                             {"platform", QGuiApplication::platformName()},
                             {"dpi", screen ? screen->logicalDotsPerInch() : 0.0},
                             {"devicePixelRatio", window.devicePixelRatioF()}};
      const QByteArray bytes = QJsonDocument(state).toJson();
      if (bytes == previous) return;
      QFile output(outputPath);
      if (output.open(QIODevice::WriteOnly) && output.write(bytes) == bytes.size()) previous = bytes;
    });
    observer->start();
  }
  // Opt-in capture directly from Qt; it is not a substitute for real-display
  // font/DPI and input-method acceptance.
  if (qEnvironmentVariableIsSet("VELLORA_SCREENSHOT")) {
    QTimer::singleShot(2500, [&window] {
      window.grab().save(qEnvironmentVariable("VELLORA_SCREENSHOT"));
      // Only isolated process tests opt into this observation. Normal launches
      // never export the open document or read a state file.
      if (!qEnvironmentVariable("VELLORA_TEST_INSTANCE").isEmpty() &&
          !qEnvironmentVariable("VELLORA_TEST_STATE").isEmpty()) {
        auto* source = window.findChild<SourceView*>();
        auto* document = window.findChild<DocumentView*>();
        const QJsonObject state{{"title", window.windowTitle()},
                               {"sourceVisible", source && source->isVisible()},
                               {"sourceText", source ? source->markdown() : QString()},
                               {"documentText", document ? document->document()->toPlainText() : QString()}};
        QFile output(qEnvironmentVariable("VELLORA_TEST_STATE"));
        if (output.open(QIODevice::WriteOnly)) output.write(QJsonDocument(state).toJson());
      }
      QApplication::quit();
    });
  }
  if (qEnvironmentVariableIsSet("VELLORA_DIALOG")) {
    QTimer::singleShot(600, [&window] {
      ModalDialog::ask(&window, QStringLiteral("文件已被外部修改"),
          QStringLiteral("文件已被其他程序修改。"), QStringLiteral("覆盖外部版本"),
          QStringLiteral("继续编辑"), true, QStringLiteral("重新加载"));
    });
  }
  if (qEnvironmentVariableIsSet("VELLORA_DEBUG_TREE")) {
    QTimer::singleShot(1500, [] {
      QFile file(QDir::temp().filePath(QStringLiteral("vellora-widgets.txt")));
      if (!file.open(QIODevice::WriteOnly | QIODevice::Text)) return;
      QTextStream out(&file);
      for (QWidget* widget : QApplication::allWidgets()) {
        out << QStringLiteral("%1 vis=%2 rect=%3,%4 %5x%6 parent=%7")
                   .arg(QString::fromLatin1(widget->metaObject()->className()))
                   .arg(widget->isVisible() ? 1 : 0).arg(widget->x()).arg(widget->y())
                   .arg(widget->width()).arg(widget->height())
                   .arg(widget->parentWidget() ? QString::fromLatin1(widget->parentWidget()->metaObject()->className()) : QStringLiteral("-")) << '\n';
      }
    });
  }
#endif
  if (!initialPath.isEmpty()) {
    window.openPath(initialPath, initialSource);
#ifdef VELLORA_ENABLE_TEST_HOOKS
    if (qEnvironmentVariableIsSet("VELLORA_SEARCH")) {
      window.openSearchPanel(qEnvironmentVariable("VELLORA_SEARCH") == QStringLiteral("replace"));
      if (qEnvironmentVariableIsSet("VELLORA_SEARCH_QUERY")) {
        if (auto* edit = window.findChild<QLineEdit*>()) edit->setText(qEnvironmentVariable("VELLORA_SEARCH_QUERY"));
      }
    }
    if (qEnvironmentVariableIsSet("VELLORA_SCROLL")) {
      if (auto* view = window.findChild<DocumentView*>()) view->setScrollValue(qEnvironmentVariableIntValue("VELLORA_SCROLL"));
    }
#endif
  }
  return app.exec();
}
