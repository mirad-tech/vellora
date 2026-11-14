// Thin wrapper over the Rust C ABI (native/bridge). Every call returns JSON that
// the UI renders or reports; the UI never reads files or opens links itself.
#pragma once

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>

namespace bridge {

struct ImageReadResult {
  QJsonObject status;
  quint8* data = nullptr;
  qsizetype size = 0;

  ImageReadResult() = default;
  ImageReadResult(const ImageReadResult&) = delete;
  ImageReadResult& operator=(const ImageReadResult&) = delete;
  ImageReadResult(ImageReadResult&& other) noexcept;
  ImageReadResult& operator=(ImageReadResult&& other) noexcept;
  ~ImageReadResult();

  bool ok() const { return status.value(QStringLiteral("ok")).toBool(); }

  QByteArray rawView() const {
    return (data != nullptr && size > 0)
               ? QByteArray::fromRawData(reinterpret_cast<const char*>(data), size)
               : QByteArray();
  }

  QByteArray ownedBytes() const {
    return (data != nullptr && size > 0)
               ? QByteArray(reinterpret_cast<const char*>(data), size)
               : QByteArray();
  }
};

QJsonObject openDocument(const QString& path);
QJsonObject planFor(const QString& markdown);
QJsonObject saveDocument(const QString& path, const QString& content, const QString& conflictToken);
ImageReadResult readImage(const QString& documentPath, const QString& source);
QJsonObject resolveImage(const QString& documentPath, const QString& source);
QJsonObject inspectLink(const QString& documentPath, const QString& href);
QJsonObject openLink(const QString& documentPath, const QString& href);
QJsonObject openExternal(const QString& url);
QJsonObject spliceSegments(const QString& content, const QJsonArray& edits);
QJsonObject sessionMatches(const QString& path);
QString version();

}  // namespace bridge
