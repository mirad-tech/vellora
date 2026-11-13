#include "bridge.h"

#include <QJsonDocument>
#include <QJsonObject>

extern "C" {
char* vellora_open(const char* path);
char* vellora_plan(const char* content);
char* vellora_save(const char* path, const char* content, const char* token);
char* vellora_image_bytes(const char* documentPath, const char* src);
char* vellora_image(const char* documentPath, const char* src);
char* vellora_inspect_link(const char* documentPath, const char* href);
char* vellora_open_link(const char* documentPath, const char* href);
char* vellora_open_external(const char* url);
char* vellora_session_matches(const char* path);
char* vellora_version();
char* vellora_splice_text(const char* content, const char* edits);
void vellora_free(char* pointer);
}

namespace {

QJsonObject consume(char* raw) {
  if (raw == nullptr) {
    return QJsonObject{{"ok", false}, {"code", "BRIDGE"}, {"message", "native bridge returned null"}};
  }
  const QByteArray bytes(raw);
  vellora_free(raw);
  const QJsonDocument document = QJsonDocument::fromJson(bytes);
  if (!document.isObject()) {
    return QJsonObject{{"ok", false}, {"code", "BRIDGE"}, {"message", "invalid bridge payload"}};
  }
  return document.object();
}

QByteArray utf8(const QString& value) { return value.toUtf8(); }

}  // namespace

namespace bridge {

QJsonObject openDocument(const QString& path) {
  return consume(vellora_open(utf8(path).constData()));
}

QJsonObject planFor(const QString& markdown) {
  return consume(vellora_plan(utf8(markdown).constData()));
}

QJsonObject saveDocument(const QString& path, const QString& content, const QString& conflictToken) {
  return consume(vellora_save(utf8(path).constData(), utf8(content).constData(),
                              utf8(conflictToken).constData()));
}

QJsonObject readImage(const QString& documentPath, const QString& source) {
  return consume(vellora_image_bytes(utf8(documentPath).constData(), utf8(source).constData()));
}

QJsonObject resolveImage(const QString& documentPath, const QString& source) {
  return consume(vellora_image(utf8(documentPath).constData(), utf8(source).constData()));
}

QJsonObject inspectLink(const QString& documentPath, const QString& href) {
  return consume(vellora_inspect_link(utf8(documentPath).constData(), utf8(href).constData()));
}

QJsonObject openLink(const QString& documentPath, const QString& href) {
  return consume(vellora_open_link(utf8(documentPath).constData(), utf8(href).constData()));
}

QJsonObject openExternal(const QString& url) {
  return consume(vellora_open_external(utf8(url).constData()));
}

QJsonObject spliceSegments(const QString& content, const QJsonArray& edits) {
  const QByteArray payload = QJsonDocument(edits).toJson(QJsonDocument::Compact);
  return consume(vellora_splice_text(utf8(content).constData(), payload.constData()));
}

QJsonObject sessionMatches(const QString& path) {
  return consume(vellora_session_matches(utf8(path).constData()));
}

QString version() {
  const QJsonObject result = consume(vellora_version());
  return result.value("version").toString();
}

}  // namespace bridge
