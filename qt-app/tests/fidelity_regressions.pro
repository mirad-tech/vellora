QT += core gui widgets svg testlib network
CONFIG += c++17 testcase console
CONFIG -= debug_and_release app_bundle
TEMPLATE = app
TARGET = vellora-fidelity-regressions
DEFINES += NOMINMAX WIN32_LEAN_AND_MEAN
INCLUDEPATH += $$PWD/../src
SOURCES += fidelity_regressions.cpp ../src/bridge.cpp ../src/code_highlight.cpp ../src/document_view.cpp ../src/document_accessibility.cpp
HEADERS += ../src/bridge.h ../src/code_highlight.h ../src/document_view.h ../src/document_accessibility.h ../src/theme.h
include($$PWD/../bridge.pri)
RESOURCES += $$PWD/../resources.qrc
win32-msvc* {
    QMAKE_LFLAGS += /MANIFESTINPUT:$$shell_quote($$shell_path($$PWD/../windows.manifest))
    PRE_TARGETDEPS += $$quote($$PWD/../windows.manifest)
}

HEADERS += $$PWD/../src/image_decode.h
