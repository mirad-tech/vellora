// Thin wrapper over the Rust C ABI (native/bridge). Every call returns JSON that
// the UI renders or reports; the UI never reads files or opens links itself.
#pragma once

#include <functional>

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
QJsonObject statImage(const QString& documentPath, const QString& source);
QJsonObject resolveImage(const QString& documentPath, const QString& source);
QJsonObject inspectLink(const QString& documentPath, const QString& href);
QJsonObject openLink(const QString& documentPath, const QString& href);
QJsonObject openExternal(const QString& url);
QJsonObject spliceSegments(const QString& content, const QJsonArray& edits);
QJsonObject sessionMatches(const QString& path);
// Renames a Markdown file or folder in place and moves the session with it.
QJsonObject renameEntry(const QString& path, const QString& newName);
// Creates an empty Markdown file; an empty name picks a free "未命名.md".
QJsonObject createMarkdown(const QString& directory, const QString& name);
// Removes an abandoned new file, only while it is still empty.
QJsonObject removeEmptyMarkdown(const QString& path);
// Describes moving `path` into `directory` before it happens: {ok, path, name,
// isDir, target, sameFolder, containsSession, relativeReferences, examples}.
// `draft` is the open document's unsaved text, or null. Changes nothing.
QJsonObject inspectMove(const QString& path, const QString& directory, const QString* draft);
// Moves a Markdown file or folder into `directory` on the same drive and moves
// the session with it: {ok, path, name, isDir, sessionPath}.
QJsonObject moveEntry(const QString& path, const QString& directory);
// Describes a file or folder before it is deleted: {ok, path, name, isDir,
// containsSession}. Changes nothing.
QJsonObject inspectDelete(const QString& path);
// Deletes a Markdown file or folder and closes the session when the open
// document goes with it. `permanent` false moves it to the recycle bin and fails
// with RECYCLE_UNAVAILABLE, touching nothing, where that is not possible.
QJsonObject deleteEntry(const QString& path, bool permanent);
// Tests only: replaces the shell for deleteEntry(). Returns 0 when deleted, 1
// when the entry cannot be recycled, otherwise an HRESULT. Empty restores it.
using DiskDeleter = std::function<int(const QString& path, bool permanent)>;
void setDiskDeleterForTesting(DiskDeleter deleter);
QString version();
// Language of the core's messages, for the whole process: "zh" (default) or "en".
bool setLanguage(const QString& tag);

}  // namespace bridge
