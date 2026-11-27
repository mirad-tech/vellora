QT += core gui widgets svg testlib network concurrent
CONFIG += c++17 testcase console
CONFIG -= debug_and_release app_bundle
TEMPLATE = app
TARGET = vellora-i18n-regressions
DEFINES += NOMINMAX WIN32_LEAN_AND_MEAN
INCLUDEPATH += $$PWD/../src
SOURCES += i18n_regressions.cpp ../src/bridge.cpp ../src/code_highlight.cpp ../src/chrome.cpp ../src/document_view.cpp ../src/main_window.cpp ../src/source_view.cpp
HEADERS += ../src/bridge.h ../src/code_highlight.h ../src/chrome.h ../src/document_view.h ../src/main_window.h ../src/source_view.h ../src/theme.h
include($$PWD/../bridge.pri)

RESOURCES += $$PWD/../resources.qrc

SOURCES += $$PWD/../src/document_accessibility.cpp
HEADERS += $$PWD/../src/document_accessibility.h

win32-msvc* {
    QMAKE_LFLAGS += /MANIFESTINPUT:$$shell_quote($$shell_path($$PWD/../windows.manifest))
    PRE_TARGETDEPS += $$quote($$PWD/../windows.manifest)
}

HEADERS += $$PWD/../src/image_decode.h

SOURCES += $$PWD/../src/file_tree_panel.cpp
HEADERS += $$PWD/../src/file_tree_panel.h

SOURCES += $$PWD/../src/app_settings.cpp
HEADERS += $$PWD/../src/app_settings.h

# The English translation, embedded as in the app (vellora.pro).
SOURCES += $$PWD/../src/ui_language.cpp
HEADERS += $$PWD/../src/ui_language.h $$PWD/../src/ui_text.h
TRANSLATIONS += $$PWD/../translations/vellora_en.ts
CONFIG += lrelease embed_translations
