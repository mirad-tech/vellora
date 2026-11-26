#pragma once

#include <QSettings>
#include <QString>

#include <memory>

// Where Vellora keeps its settings. An installed copy uses the per-user store
// (the registry on Windows). A copy whose folder holds portable.txt keeps them
// in Vellora.ini beside the program instead, so nothing is left on the machine
// and the settings travel with the folder.
namespace app_settings {

// Decides the store once, at startup. When the marker is present but the
// folder cannot be written (Program Files, a write-protected stick), settings
// stay in the per-user store rather than being silently lost.
void configure(const QString& applicationDir);

bool isPortable();
// Empty unless portable.
QString iniPath();

std::unique_ptr<QSettings> open();

// In portable mode a folder on the program's drive is stored relative to the
// program folder, so it still opens after the stick gets another drive letter.
// Paths on other drives or shares, and every path outside portable mode, are
// stored as written.
QString storePath(const QString& path);
QString resolvePath(const QString& stored);

// Saves a folder under `key` as written and, in portable mode, also relative to
// the program under `key` + "Relative" when it is on the program's drive.
void saveFolder(QSettings& settings, const QString& key, const QString& path);
// The relative spelling while it still names a folder (the stick got another
// letter), otherwise the one as written (the program moved on its drive).
QString loadFolder(const QSettings& settings, const QString& key);

}  // namespace app_settings
