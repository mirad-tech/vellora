#include "app_settings.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QTemporaryFile>

#include <string>

#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif

namespace app_settings {
namespace {

QString programDir;
QString iniFile;

// The full Windows spelling, so relative paths are computed against the same
// long names the file tree reports, never against an 8.3 short path.
QString longPath(const QString& path) {
  const QString clean = QDir::cleanPath(QDir::fromNativeSeparators(QFileInfo(path).absoluteFilePath()));
#ifdef Q_OS_WIN
  // A short name always contains '~'. Skipping the rest also keeps a share
  // path from touching the network.
  if (!clean.contains(QLatin1Char('~'))) return clean;
  const std::wstring native = QDir::toNativeSeparators(clean).toStdWString();
  const DWORD size = GetLongPathNameW(native.c_str(), nullptr, 0);
  if (size > 0) {
    std::wstring buffer(size, L'\0');
    const DWORD written = GetLongPathNameW(native.c_str(), buffer.data(), size);
    if (written > 0 && written < size) {
      buffer.resize(written);
      return QDir::cleanPath(QDir::fromNativeSeparators(QString::fromStdWString(buffer)));
    }
  }
#endif
  return clean;
}

}  // namespace

void configure(const QString& applicationDir) {
  programDir.clear();
  iniFile.clear();
  if (applicationDir.isEmpty()) return;
  const QString dir = longPath(applicationDir);
  if (!QFileInfo(QDir(dir).filePath(QStringLiteral("portable.txt"))).isFile()) return;
  const QString ini = QDir(dir).filePath(QStringLiteral("Vellora.ini"));
  // ReadWrite creates a missing file without truncating an existing one and
  // fails on a read-only file. QSettings saves through a temporary file in the
  // same folder, so the folder itself must accept new files too.
  QFile probe(ini);
  if (!probe.open(QIODevice::ReadWrite)) return;
  probe.close();
  QTemporaryFile scratch(QDir(dir).filePath(QStringLiteral("Vellora.XXXXXX.tmp")));
  if (!scratch.open()) return;
  programDir = dir;
  iniFile = ini;
}

bool isPortable() { return !iniFile.isEmpty(); }

QString iniPath() { return iniFile; }

std::unique_ptr<QSettings> open() {
  if (iniFile.isEmpty()) return std::make_unique<QSettings>();
  return std::make_unique<QSettings>(iniFile, QSettings::IniFormat);
}

QString storePath(const QString& path) {
  if (programDir.isEmpty() || path.isEmpty()) return path;
  const QString relative = QDir(programDir).relativeFilePath(longPath(path));
  // Another drive or a UNC share has no relative spelling.
  if (!QDir::isRelativePath(relative)) return path;
  return relative.isEmpty() ? QStringLiteral(".") : relative;
}

QString resolvePath(const QString& stored) {
  if (programDir.isEmpty() || stored.isEmpty() || !QDir::isRelativePath(stored)) return stored;
  return QDir::cleanPath(QDir(programDir).filePath(stored));
}

void saveFolder(QSettings& settings, const QString& key, const QString& path) {
  settings.setValue(key, path);
  const QString relativeKey = key + QStringLiteral("Relative");
  const QString relative = storePath(path);
  if (!programDir.isEmpty() && !path.isEmpty() && QDir::isRelativePath(relative)) {
    settings.setValue(relativeKey, relative);
  } else {
    settings.remove(relativeKey);
  }
}

QString loadFolder(const QSettings& settings, const QString& key) {
  const QString relative = settings.value(key + QStringLiteral("Relative")).toString();
  if (!programDir.isEmpty() && !relative.isEmpty() && QDir::isRelativePath(relative)) {
    const QString resolved = resolvePath(relative);
    if (QFileInfo(resolved).isDir()) return resolved;
  }
  // A relative value here was written by an early 0.1.7 build.
  return resolvePath(settings.value(key).toString());
}

}  // namespace app_settings
