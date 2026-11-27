#!/usr/bin/env bash
# Linux (and other Unix) counterpart of build.ps1: build the Rust bridge, then
# the Qt shell, and optionally the Rust + Qt regression suites.
#
# Requires: Rust (cargo), a C++17 compiler, make, and Qt 6 (qtbase + qtsvg)
# with qmake6 or qmake on PATH. Set QMAKE to pick a specific qmake.
#
# Usage: qt-app/build.sh [--debug] [--clean] [--test] [--build-root DIR]
#                        [--cargo-target-dir DIR] [--jobs N]
set -euo pipefail

project="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
native="$(dirname "$project")"
spec=release
clean=0
run_tests=0
build_root=""
cargo_target_dir="${CARGO_TARGET_DIR:-}"
jobs="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) spec=debug ;;
    --clean) clean=1 ;;
    --test) run_tests=1 ;;
    --build-root) build_root="$2"; shift ;;
    --cargo-target-dir) cargo_target_dir="$2"; shift ;;
    --jobs|-j) jobs="$2"; shift ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$build_root" ]] || build_root="$native/target/qt-$spec"
[[ -n "$cargo_target_dir" ]] || cargo_target_dir="$native/target"
mkdir -p "$build_root" "$cargo_target_dir"
build_root="$(cd "$build_root" && pwd)"
cargo_target_dir="$(cd "$cargo_target_dir" && pwd)"

if [[ -z "${QMAKE:-}" ]]; then
  if command -v qmake6 >/dev/null 2>&1; then QMAKE=qmake6
  elif command -v qmake >/dev/null 2>&1; then QMAKE=qmake
  else echo "qmake6/qmake not found; install Qt 6 or set QMAKE." >&2; exit 1
  fi
fi
qt_version="$("$QMAKE" -query QT_VERSION)"
if [[ "${qt_version%%.*}" != 6 ]]; then
  echo "Qt 6 is required; $QMAKE reports Qt $qt_version." >&2
  exit 1
fi
echo "Qt: $qt_version ($QMAKE); output: $build_root"

export CARGO_TARGET_DIR="$cargo_target_dir"
cargo_args=(build --manifest-path "$native/Cargo.toml" --locked -p vellora-bridge)
[[ "$spec" == release ]] && cargo_args+=(--release)
cargo "${cargo_args[@]}"
bridge="$cargo_target_dir/$spec"
[[ -f "$bridge/libvellora_bridge.a" ]] || { echo "Missing newly built bridge: $bridge" >&2; exit 1; }

if [[ "$run_tests" == 1 ]]; then
  cargo test --manifest-path "$native/Cargo.toml" --locked -p vellora-core -p vellora-md -p vellora-bridge
fi

build_qt_project() {
  local pro="$1" output="$2" test_hooks="${3:-0}" defines
  mkdir -p "$output"
  (
    cd "$output"
    # Let the generated makefile clean only its own outputs. Never glob sources.
    if [[ "$clean" == 1 && -f Makefile ]]; then make clean; fi
    if [[ "$test_hooks" == 1 ]]; then defines='DEFINES+=VELLORA_ENABLE_TEST_HOOKS'
    else defines='DEFINES-=VELLORA_ENABLE_TEST_HOOKS'; fi
    "$QMAKE" "$pro" "$defines" "CONFIG+=$spec" 'CONFIG-=debug_and_release' "BRIDGE_DIR=$bridge" \
      ${PREFIX:+"PREFIX=$PREFIX"}
    make -j"$jobs"
  )
}

build_qt_project "$project/vellora.pro" "$build_root/app"
exe="$build_root/app/vellora"
[[ -x "$exe" ]] || { echo "Missing built app: $exe" >&2; exit 1; }

if [[ "$run_tests" == 1 ]]; then
  build_qt_project "$project/vellora.pro" "$build_root/test-app" 1
  # project:output directory:executable, the same suites as build.ps1.
  suites=(
    "regressions:tests:vellora-regressions"
    "accessibility_regressions:accessibility-tests:vellora-accessibility-regressions"
    "serialization_regressions:serialization-tests:vellora-serialization-regressions"
    "code_copy_regressions:code-copy-tests:vellora-code-copy-regressions"
    "conflict_regressions:conflict-tests:vellora-conflict-regressions"
    "feedback_document_regressions:feedback-document-tests:vellora-feedback-document-regressions"
    "focused_ui_feedback:focused-ui-tests:vellora-focused-ui-feedback"
    "parity_document_regressions:parity-document-tests:vellora-parity-document-regressions"
    "chrome_accessibility_regressions:chrome-accessibility-tests:vellora-chrome-accessibility-regressions"
    "chrome_ui_regressions:chrome-ui-tests:vellora-chrome-ui-regressions"
    "highlight_parity:highlight-parity-tests:vellora-highlight-parity"
    "body_layout_regressions:body-layout-tests:vellora-body-layout-regressions"
    "ime_raw_regressions:ime-raw-tests:vellora-ime-raw-regressions"
    "fidelity_regressions:fidelity-tests:vellora-fidelity-regressions"
    "theme_regressions:theme-tests:vellora-theme-regressions"
    "rename_regressions:rename-tests:vellora-rename-regressions"
    "file_tree_regressions:file-tree-tests:vellora-file-tree-regressions"
    "i18n_regressions:i18n-tests:vellora-i18n-regressions"
  )
  # VELLORA_QT_SUITES="regressions theme_regressions" limits the run.
  selected="${VELLORA_QT_SUITES:-}"
  for suite in "${suites[@]}"; do
    IFS=: read -r pro out _ <<<"$suite"
    [[ -z "$selected" || " $selected " == *" $pro "* ]] || continue
    build_qt_project "$project/tests/$pro.pro" "$build_root/$out"
  done
  failed=()
  export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-offscreen}"
  for suite in "${suites[@]}"; do
    IFS=: read -r pro out bin <<<"$suite"
    [[ -z "$selected" || " $selected " == *" $pro "* ]] || continue
    output="$build_root/$out"
    set +e
    "$output/$bin" -o "$output/results.xml,junitxml" -o "$output/results.txt,txt"
    status=$?
    set -e
    [[ -f "$output/results.txt" ]] && cat "$output/results.txt"
    [[ "$status" == 0 ]] || failed+=("$pro: $status")
  done
  if [[ ${#failed[@]} -gt 0 ]]; then
    printf 'Qt regressions failed: %s\n' "${failed[*]}" >&2
    exit 1
  fi
fi
echo "Built: $exe"
