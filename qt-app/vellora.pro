QT += core gui widgets svg network concurrent
CONFIG += c++17
CONFIG -= debug_and_release
TEMPLATE = app
TARGET = vellora

DEFINES += NOMINMAX WIN32_LEAN_AND_MEAN

INCLUDEPATH += $$PWD/src

SOURCES += \
    src/main.cpp \
    src/bridge.cpp \
    src/code_highlight.cpp \
    src/chrome.cpp \
    src/document_view.cpp \
    src/main_window.cpp \
    src/source_view.cpp

HEADERS += \
    src/bridge.h \
    src/code_highlight.h \
    src/chrome.h \
    src/document_view.h \
    src/main_window.h \
    src/source_view.h \
    src/theme.h

# Rust core + markdown engine, linked as a static library.
include($$PWD/bridge.pri)

RC_ICONS = $$PWD/../installer/assets/vellora.ico
VERSION = 0.1.8
QMAKE_TARGET_PRODUCT = "Vellora"
QMAKE_TARGET_DESCRIPTION = "Vellora"
QMAKE_TARGET_COMPANY = "Vellora Contributors"

RESOURCES += $$PWD/resources.qrc

SOURCES += $$PWD/src/document_accessibility.cpp
HEADERS += $$PWD/src/document_accessibility.h

win32-msvc* {
    QMAKE_LFLAGS += /MANIFESTINPUT:$$shell_quote($$shell_path($$PWD/windows.manifest))
    PRE_TARGETDEPS += $$quote($$PWD/windows.manifest)
}

HEADERS += $$PWD/src/image_decode.h

SOURCES += $$PWD/src/file_tree_panel.cpp
HEADERS += $$PWD/src/file_tree_panel.h

SOURCES += $$PWD/src/app_settings.cpp
HEADERS += $$PWD/src/app_settings.h

# UI language: Simplified Chinese source text, English from translations/.
# lrelease compiles the .ts and embed_translations puts the .qm in the
# resources under :/i18n, so nothing ships beside the executable.
SOURCES += $$PWD/src/ui_language.cpp
HEADERS += $$PWD/src/ui_language.h $$PWD/src/ui_text.h
TRANSLATIONS += $$PWD/translations/vellora_en.ts
CONFIG += lrelease embed_translations

# Linux / BSD: `make install` (honours INSTALL_ROOT) lays out the binary,
# desktop entry, MIME glob and hicolor icons under PREFIX (default /usr/local).
unix:!macx {
    isEmpty(PREFIX): PREFIX = /usr/local
    target.path = $$PREFIX/bin
    desktop.files = $$PWD/../installer/linux/vellora.desktop
    desktop.path = $$PREFIX/share/applications
    mime.files = $$PWD/../installer/linux/vellora-markdown.xml
    mime.path = $$PREFIX/share/mime/packages
    for(size, $$list(16 24 32 48 64 256)) {
        icon_$${size}.path = $$PREFIX/share/icons/hicolor/$${size}x$${size}/apps
        icon_$${size}.extra = mkdir -p $$shell_quote($(INSTALL_ROOT)$$PREFIX/share/icons/hicolor/$${size}x$${size}/apps) && $$QMAKE_COPY $$shell_quote($$PWD/../installer/linux/icons/vellora-$${size}.png) $$shell_quote($(INSTALL_ROOT)$$PREFIX/share/icons/hicolor/$${size}x$${size}/apps/vellora.png)
        # Installed under the theme name "vellora" by the copy above.
        INSTALLS += icon_$${size}
    }
    INSTALLS += target desktop mime
}
