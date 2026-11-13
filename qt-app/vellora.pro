QT += core gui widgets svg network
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
isEmpty(BRIDGE_DIR): BRIDGE_DIR = $$PWD/../target/release
PRE_TARGETDEPS += $$quote($$BRIDGE_DIR/vellora_bridge.lib)
LIBS += $$quote($$BRIDGE_DIR/vellora_bridge.lib)
LIBS += -lws2_32 -ladvapi32 -luserenv -lbcrypt -lntdll -ldbghelp -lole32 -lshell32 -luser32 -lgdi32 -lcomdlg32 -loleaut32 -luuid

RC_ICONS = $$PWD/../installer/assets/vellora.ico
VERSION = 0.1.1
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
