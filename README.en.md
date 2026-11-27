# Vellora

[中文](README.md) | English

A Markdown reader and editor for Windows and Linux.

## Features

- Read rendered Markdown and edit the text in place, or switch to source mode.
- Sidebar: file tree and outline share one panel (`Ctrl+\` to switch). Open a folder, create files, press `F2` to rename, press `Delete` to send to the Recycle Bin, and drag files or folders onto another folder to move them. Renaming or moving the document you are editing does not interrupt editing.
- Find and replace, undo and redo, and saving; when switching files you can choose "Save and Switch".
- Headings, block quotes, ordered and unordered lists, task lists, tables, images, and code blocks.
- Chinese input methods and first-line indent for Chinese paragraphs; light and dark themes follow the system setting.
- The interface language follows the system: Simplified Chinese when the Windows display language is Chinese (Simplified or Traditional), English otherwise. The installer picks Chinese or English the same way.
- A portable version: unzip and run, with settings kept in the program folder.

## Download and install

The Windows version is for **Windows 10 / 11 x64 (64-bit)**; for Linux, see [Linux version](#linux-version). Most users only need the installer; no developer tools or building required.

[Open the latest release](https://github.com/mirad-tech/vellora/releases/latest)

### 1. Download the installer

1. Open the **latest release** page linked above.
2. Find **Assets** near the bottom of the page and expand it if it is collapsed.
3. Click **`Vellora-Setup-<version>.exe`** (for example `Vellora-Setup-0.1.8.exe`) and wait for the download to finish.
4. Do not pick `Source code (zip)` or `Source code (tar.gz)`: those are source code, not an installable program.

### 2. Install Vellora

1. If Vellora is running, save your documents and close it first.
2. Double-click the downloaded installer. An existing older version is upgraded in place.
3. Follow the wizard, read and accept the license, then choose where to install. The default is `%LOCALAPPDATA%\Programs\Vellora` for the current user, which is fine for most people.
4. On the **Markdown File Association** page, choose what suits you:
   - **Leave it unchecked** to keep your current file associations. You can still open documents from inside Vellora with "Open".
   - **Check "Add Vellora to Open with for Markdown files and open Default apps settings"** to have Windows Settings open after setup so you can pick the default app. Checking it does not replace your current default app by itself.
5. Click **Install**, wait for it to finish, then click **Finish**.
6. Start **Vellora** from the desktop shortcut or the Start menu, click **Open**, and pick a `.md` or `.markdown` file.

### Portable version

If you prefer not to install, lack install rights, or want to run it from a USB drive, download `Vellora-<version>-portable-x64.zip`:

1. Unzip the whole archive into any folder, for example `D:\Tools\Vellora` or a USB drive.
2. Double-click `vellora.exe` inside it. No installation or administrator rights needed. Do not copy `vellora.exe` out on its own; it needs the other files in the same folder.
3. When you no longer need it, delete the whole folder.

The portable folder contains `portable.txt`, so settings such as window size and the folder open in the sidebar are saved to `Vellora.ini` in the same folder instead of the registry. If the folder is not writable (for example under Program Files), settings fall back to the registry at `HKEY_CURRENT_USER\Software\Vellora Contributors\Vellora`. The portable version does not register file associations or create shortcuts.

### 3. Optional: make Vellora the default for Markdown

If you checked the file association option during setup, in **Windows Settings → Apps → Default apps** choose **Vellora** for both `.md` and `.markdown`:

- **Windows 11**: search for the file extension (for example `.md`), select Vellora and confirm, then repeat for `.markdown`.
- **Windows 10**: open "Choose default apps by file type", find both extensions, and select Vellora for each.

You can also right-click a Markdown file, choose **Open with → Choose another app**, select Vellora, and confirm you always want to use it. Button labels may differ slightly between Windows versions.

### Security notice and checksum verification

The installer and portable version are **not digitally signed yet**, so Windows may show "Windows protected your PC" or an unknown publisher warning. That does not mean the file has passed any security review. Download only from this repository's Releases, and only choose **More info → Run anyway** (if Windows offers it) after confirming the source, the file name, and the checksum on the release page, and deciding you want to continue.

Do not turn off your antivirus or SmartScreen. If the checksum does not match, you get a clear malware alert, or your device is restricted by organization policy, stop and do not force the installation.

Optional check: open PowerShell in the folder containing the download, run the commands below, and compare the output Hash with the values in the release page's checksum section (titled "下载校验"):

```powershell
Get-FileHash -Algorithm SHA256 .\Vellora-Setup-*.exe
Get-FileHash -Algorithm SHA256 .\Vellora-*-portable-x64.zip
```

### Linux version

On the latest release page, under **Assets**, download the AppImage for your machine:

- `Vellora-<version>-x86_64.AppImage`: x86_64 PCs, needs glibc 2.35 or newer (Ubuntu 22.04, Debian 12, or later).
- `Vellora-<version>-aarch64.AppImage`: ARM64 machines, needs glibc 2.39 or newer (Ubuntu 24.04, Debian 13, or later).

Make it executable, then run it, for example:

```sh
chmod +x Vellora-*-x86_64.AppImage
./Vellora-*-x86_64.AppImage
```

To verify, run `sha256sum Vellora-*.AppImage` and compare the output with the release page's checksum section.

## Building

The interface uses Qt Widgets; Markdown and file handling are in Rust, linked through a static bridge.

You need the Rust MSVC toolchain, Visual Studio C++ x64 Build Tools, the Windows SDK, and Qt 6.8.3 MSVC2022 x64 (qtbase, qtsvg, qtimageformats). From PowerShell in the repository root, run:

```powershell
.\qt-app\build.ps1 -QtRoot 'C:\Qt\6.8.3\msvc2022_64' -Test -EmitLegacyOutput $false
```

Replace the Qt path with your own install location. The output is `target\qt-release\app\vellora.exe`, which needs the matching Qt DLLs to run. `-Test` runs the Rust and Qt automated tests.

The packaging script is `installer\package-qt.ps1`. It also needs the official NSIS, passed as `makensis.exe` through `-MakeNsis`, and the Qt install must keep the SBOMs for the modules above. The script produces a portable folder with its runtime dependencies, the installer, and the portable zip; it does not install anything. See the [packaging and installer notes](installer/README.md) (Chinese) for commands, outputs, and upgrade rules.

### Linux

You need Rust (stable, from `rustup` or your distribution's cargo), a C++17 compiler, `make`, and Qt 6 (qtbase, qtsvg; 6.8 LTS recommended, a distribution's Qt 6.8 works too). On Debian / Ubuntu:

```sh
sudo apt install build-essential qt6-base-dev qt6-base-dev-tools qt6-svg-dev qmake6
./qt-app/build.sh --test
```

The script uses `qmake6` from PATH first; set `QMAKE=/path/to/qt/bin/qmake` to use another Qt. The output is `target/qt-release/app/vellora`. `--test` runs the Rust and Qt automated tests in headless (offscreen) mode; `--debug` and `--clean` mean the same as in the Windows script.

Install system-wide (with the `.desktop` launcher, the `text/markdown` association, and icons):

```sh
PREFIX=/usr/local ./qt-app/build.sh
sudo make -C target/qt-release/app install
sudo update-desktop-database; sudo update-mime-database /usr/local/share/mime
```

Build an AppImage (downloads linuxdeploy and its Qt plugin automatically; no FUSE needed):

```sh
./installer/linux/package-appimage.sh            # output in target/appimage/
```

An AppImage only runs on distributions whose glibc is at least as new as the build machine's. CI builds with Qt 6.8.3, x86_64 on Ubuntu 22.04 and aarch64 on Ubuntu 24.04, and uploads both AppImages as build artifacts.

## License

The project is under the [MIT License](LICENSE). Qt and other third-party components follow their own licenses; their notices ship with the installer.
