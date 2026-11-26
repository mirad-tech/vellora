#!/usr/bin/env bash
# Builds Vellora and packs it into an AppImage with linuxdeploy and its Qt plugin.
#
# Usage: installer/linux/package-appimage.sh [OUTPUT_DIR]
#   QMAKE            qmake of the Qt 6 to bundle (default: qmake6 or qmake on PATH)
#   VELLORA_VERSION  version in the file name (default: workspace version)
#   VELLORA_ARCH     x86_64 or aarch64 (default: from uname -m)
#   LINUXDEPLOY_DIR  where linuxdeploy tools are cached (default: target/linuxdeploy)
#   SKIP_BUILD=1     reuse an existing target/qt-release/app build
#
# The AppImage runs on distributions whose glibc is at least the one it was built
# against, so build on the oldest distribution you want to support.
set -euo pipefail

linux_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$linux_dir/../.." && pwd)"
out_dir="${1:-$root/target/appimage}"
# linuxdeploy publishes its tools as x86_64 and aarch64 builds; normalise the
# names other tools use for the same machines.
case "${VELLORA_ARCH:-$(uname -m)}" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "Unsupported architecture: ${VELLORA_ARCH:-$(uname -m)}" >&2; exit 1 ;;
esac
tools="${LINUXDEPLOY_DIR:-$root/target/linuxdeploy}"
# Cargo.toml may be checked out with CRLF line endings; strip the \r so it
# never ends up in the AppImage file name.
version="${VELLORA_VERSION:-$(tr -d '\r' <"$root/Cargo.toml" | sed -n 's/^version *= *"\(.*\)"/\1/p' | head -n1)}"
version="${version//$'\r'/}"
[[ "$version" =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "Bad version: '$version'" >&2; exit 1; }
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
export ARCH="$arch"
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
