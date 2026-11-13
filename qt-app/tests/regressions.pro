QT += core gui widgets svg testlib network
CONFIG += c++17 testcase console
CONFIG -= debug_and_release app_bundle
TEMPLATE = app
TARGET = vellora-regressions
DEFINES += NOMINMAX WIN32_LEAN_AND_MEAN
INCLUDEPATH += $$PWD/../src
SOURCES += regressions.cpp ../src/bridge.cpp ../src/code_highlight.cpp ../src/chrome.cpp ../src/document_view.cpp ../src/main_window.cpp ../src/source_view.cpp
HEADERS += ../src/bridge.h ../src/code_highlight.h ../src/chrome.h ../src/document_view.h ../src/main_window.h ../src/source_view.h ../src/theme.h
isEmpty(BRIDGE_DIR): BRIDGE_DIR = $$PWD/../../target/release
PRE_TARGETDEPS += $$quote($$BRIDGE_DIR/vellora_bridge.lib)
LIBS += $$quote($$BRIDGE_DIR/vellora_bridge.lib)
LIBS += -lws2_32 -ladvapi32 -luserenv -lbcrypt -lntdll -ldbghelp -lole32 -lshell32 -luser32 -lgdi32 -lcomdlg32 -loleaut32 -luuid

RESOURCES += $$PWD/../resources.qrc

SOURCES += $$PWD/../src/document_accessibility.cpp
HEADERS += $$PWD/../src/document_accessibility.h

win32-msvc* {
    QMAKE_LFLAGS += /MANIFESTINPUT:$$shell_quote($$shell_path($$PWD/../windows.manifest))
    PRE_TARGETDEPS += $$quote($$PWD/../windows.manifest)
}

HEADERS += $$PWD/../src/image_decode.h
