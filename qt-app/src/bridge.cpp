#include "bridge.h"

#include <cstddef>
#include <cstdint>
#include <utility>

#include <QJsonDocument>
#include <QJsonObject>

extern "C" {
char* vellora_open(const char* path);
char* vellora_plan_n(const uint8_t* content, size_t contentLen);
char* vellora_save_n(const char* path, const uint8_t* content, size_t contentLen, const char* token);
char* vellora_image_read(const char* documentPath, const char* src, uint8_t** data, size_t* len);
void vellora_free_bytes(uint8_t* data, size_t len);
char* vellora_image_stat(const char* documentPath, const char* src);
char* vellora_image(const char* documentPath, const char* src);
char* vellora_inspect_link(const char* documentPath, const char* href);
char* vellora_open_link(const char* documentPath, const char* href);
char* vellora_open_external(const char* url);
char* vellora_session_matches(const char* path);
char* vellora_version();
char* vellora_splice_text_n(const uint8_t* content, size_t contentLen, const char* edits);
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

// Document text crosses the ABI with an explicit length. U+0000 is valid Markdown
// content: passing constData() alone would let Rust stop at the first NUL and
// save a truncated file. Paths, tokens and JSON edits cannot contain NUL.
const uint8_t* bytes(const QByteArray& value) { return reinterpret_cast<const uint8_t*>(value.constData()); }
size_t length(const QByteArray& value) { return static_cast<size_t>(value.size()); }

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
  const QByteArray content = utf8(markdown);
  return consume(vellora_plan_n(bytes(content), length(content)));
}

QJsonObject saveDocument(const QString& path, const QString& content, const QString& conflictToken) {
  const QByteArray text = utf8(content);
  return consume(vellora_save_n(utf8(path).constData(), bytes(text), length(text),
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

QJsonObject statImage(const QString& documentPath, const QString& source) {
  return consume(vellora_image_stat(utf8(documentPath).constData(), utf8(source).constData()));
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
  const QByteArray draft = utf8(content);
  return consume(vellora_splice_text_n(bytes(draft), length(draft), payload.constData()));
}

QJsonObject sessionMatches(const QString& path) {
  return consume(vellora_session_matches(utf8(path).constData()));
}

QString version() {
  const QJsonObject result = consume(vellora_version());
  return result.value("version").toString();
}

}  // namespace bridge
