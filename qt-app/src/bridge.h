// Thin wrapper over the Rust C ABI (native/bridge). Every call returns JSON that
// the UI renders or reports; the UI never reads files or opens links itself.
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

namespace bridge {

QJsonObject openDocument(const QString& path);
QJsonObject planFor(const QString& markdown);
QJsonObject saveDocument(const QString& path, const QString& content, const QString& conflictToken);
QJsonObject readImage(const QString& documentPath, const QString& source);
QJsonObject resolveImage(const QString& documentPath, const QString& source);
QJsonObject inspectLink(const QString& documentPath, const QString& href);
QJsonObject openLink(const QString& documentPath, const QString& href);
QJsonObject openExternal(const QString& url);
QJsonObject spliceSegments(const QString& content, const QJsonArray& edits);
QJsonObject sessionMatches(const QString& path);
QString version();

}  // namespace bridge
