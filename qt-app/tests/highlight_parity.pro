QT += core gui widgets testlib
CONFIG += c++17 testcase console
CONFIG -= debug_and_release app_bundle
TEMPLATE = app
TARGET = vellora-highlight-parity
INCLUDEPATH += $$PWD/../src
SOURCES += highlight_parity.cpp ../src/code_highlight.cpp
HEADERS += ../src/code_highlight.h ../src/theme.h
