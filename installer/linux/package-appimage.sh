#!/usr/bin/env bash
# Builds Vellora and packs it into an AppImage with linuxdeploy and its Qt plugin.
#
# Usage: installer/linux/package-appimage.sh [OUTPUT_DIR]
#   QMAKE            qmake of the Qt 6 to bundle (default: qmake6 or qmake on PATH)
#   VELLORA_VERSION  version in the file name (default: workspace version)
#   LINUXDEPLOY_DIR  where linuxdeploy tools are cached (default: target/linuxdeploy)
#   SKIP_BUILD=1     reuse an existing target/qt-release/app build
#
# The AppImage runs on distributions whose glibc is at least the one it was built
# against, so build on the oldest distribution you want to support.
set -euo pipefail

linux_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$linux_dir/../.." && pwd)"
out_dir="${1:-$root/target/appimage}"
arch="$(uname -m)"
tools="${LINUXDEPLOY_DIR:-$root/target/linuxdeploy}"
version="${VELLORA_VERSION:-$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -n1)}"
build_root="$root/target/qt-release"
appdir="$root/target/AppDir"

if [[ -z "${QMAKE:-}" ]]; then
  if command -v qmake6 >/dev/null 2>&1; then QMAKE="$(command -v qmake6)"
  else QMAKE="$(command -v qmake)"; fi
fi
export QMAKE

if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  PREFIX=/usr "$root/qt-app/build.sh" --build-root "$build_root"
fi

rm -rf "$appdir"
make -C "$build_root/app" install INSTALL_ROOT="$appdir"

mkdir -p "$tools" "$out_dir"
fetch() {
  local name="$1" url="$2"
  if [[ ! -x "$tools/$name" ]]; then
    curl -fsSL --retry 3 -o "$tools/$name" "$url"
    chmod +x "$tools/$name"
  fi
}
fetch "linuxdeploy-$arch.AppImage" \
  "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-$arch.AppImage"
fetch "linuxdeploy-plugin-qt-$arch.AppImage" \
  "https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/download/continuous/linuxdeploy-plugin-qt-$arch.AppImage"

# Containers and CI runners often lack FUSE; extract-and-run works without it.
export APPIMAGE_EXTRACT_AND_RUN=1
export PATH="$tools:$PATH"
# linuxdeploy-plugin-qt deploys the platform, image format, icon engine (SVG)
# and style plugins Qt needs; it finds them through $QMAKE.
export LINUXDEPLOY_OUTPUT_VERSION="$version"
export LDAI_OUTPUT="$out_dir/Vellora-$version-$arch.AppImage"
export OUTPUT="$LDAI_OUTPUT"

"$tools/linuxdeploy-$arch.AppImage" \
  --appdir "$appdir" \
  --executable "$appdir/usr/bin/vellora" \
  --desktop-file "$appdir/usr/share/applications/vellora.desktop" \
  --plugin qt \
  --output appimage

echo "AppImage: $OUTPUT"
