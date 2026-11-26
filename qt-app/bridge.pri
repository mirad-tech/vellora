# Links the Rust core + markdown engine (crate vellora-bridge) as a static
# library, with the system libraries Rust's std needs on each platform.
# BRIDGE_DIR may be set on the qmake command line (build.ps1 / build.sh do).
isEmpty(BRIDGE_DIR): BRIDGE_DIR = $$clean_path($$PWD/../target/release)

win32 {
    VELLORA_BRIDGE_LIB = $$BRIDGE_DIR/vellora_bridge.lib
    PRE_TARGETDEPS += $$quote($$VELLORA_BRIDGE_LIB)
    LIBS += $$quote($$VELLORA_BRIDGE_LIB)
    LIBS += -lws2_32 -ladvapi32 -luserenv -lbcrypt -lntdll -ldbghelp -lole32 -lshell32 -luser32 -lgdi32 -lcomdlg32 -loleaut32 -luuid -lsynchronization
} else {
    # cargo builds libvellora_bridge.a; list matches
    # `cargo rustc -p vellora-bridge --crate-type staticlib -- --print native-static-libs`.
    VELLORA_BRIDGE_LIB = $$BRIDGE_DIR/libvellora_bridge.a
    PRE_TARGETDEPS += $$quote($$VELLORA_BRIDGE_LIB)
    LIBS += $$quote($$VELLORA_BRIDGE_LIB)
    macx {
        LIBS += -framework CoreFoundation -framework Security -liconv -lm
    } else {
        LIBS += -lpthread -ldl -lm -lrt -lutil
    }
}
