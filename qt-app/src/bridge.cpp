#include "bridge.h"

#include <cstddef>
#include <cstdint>
#include <utility>

#include <QJsonDocument>
#include <QJsonObject>

extern "C" {
char* vellora_open(const char* path);
char* vellora_plan(const char* content);
char* vellora_save(const char* path, const char* content, const char* token);
char* vellora_image_read(const char* documentPath, const char* src, uint8_t** data, size_t* len);
void vellora_free_bytes(uint8_t* data, size_t len);
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

ImageReadResult::ImageReadResult(ImageReadResult&& other) noexcept
    : status(std::move(other.status)),
      data(std::exchange(other.data, nullptr)),
      size(std::exchange(other.size, 0)) {}

ImageReadResult& ImageReadResult::operator=(ImageReadResult&& other) noexcept {
  if (this != &other) {
    if (data != nullptr) {
      vellora_free_bytes(data, static_cast<size_t>(size));
    }
    status = std::move(other.status);
    data = std::exchange(other.data, nullptr);
    size = std::exchange(other.size, 0);
  }
  return *this;
}

ImageReadResult::~ImageReadResult() {
  if (data != nullptr) {
    vellora_free_bytes(data, static_cast<size_t>(size));
  }
}

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

ImageReadResult readImage(const QString& documentPath, const QString& source) {
  const QByteArray docBytes = utf8(documentPath);
  const QByteArray srcBytes = utf8(source);
  uint8_t* rawData = nullptr;
  size_t rawLen = 0;
  ImageReadResult result;
  result.status = consume(vellora_image_read(docBytes.constData(), srcBytes.constData(), &rawData, &rawLen));
  result.data = rawData;
  result.size = static_cast<qsizetype>(rawLen);
  return result;
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
