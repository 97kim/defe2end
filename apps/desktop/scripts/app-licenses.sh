#!/bin/sh
# SBOM and third-party notices of the desktop app (stage 8 contract section 3), written to apps/desktop/licenses/,
# which electron-builder ships as resources/licenses (extraResources). Run after an unpacked build
# (`electron-builder --dir`) of the same target; the installer build that follows picks the files up.
# Scans the app archive's contents (npm packages) with syft, and adds what ships as plain files: Electron (with
# Chromium's notices), the Playwright Chromium and ffmpeg in browsers/<target>.
# Also writes release/<target>-files.txt (the archive's file list) for the release clean-room check.
# Usage: apps/desktop/scripts/app-licenses.sh <unpacked dir> <target: mac-arm64|mac-x64|win-x64>
set -eu
cd "$(dirname "$0")/.."
UNPACKED="$1"; TARGET="$2"
VERSION="$(node -p 'require("./package.json").version')"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
ASAR="$(find "$UNPACKED" -name app.asar | head -n 1)"
[ -n "$ASAR" ] || { echo "no app.asar under $UNPACKED" >&2; exit 1; }
npx --yes @electron/asar@4 extract "$ASAR" "$WORK/app"
(cd "$WORK/app" && find . -type f | LC_ALL=C sort) > "release/$TARGET-files.txt"
syft scan "dir:$WORK/app" -q --select-catalogers "+javascript-package-cataloger" -o "cyclonedx-json=$WORK/sbom.json"

# Electron's own license and Chromium's notices, as packaged next to the app.
electron_dir="$(dirname "$(find "$UNPACKED" -name LICENSE.electron.txt | head -n 1)")"
electron_version="$(node -p 'require("electron/package.json").version')"
set -- --extra "electron@$electron_version=MIT AND BSD-3-Clause=$electron_dir=https://github.com/electron/electron/tree/v$electron_version"
for dir in browsers/"$TARGET"/chromium-* browsers/"$TARGET"/ffmpeg-*; do
  [ -d "$dir" ] || continue
  base="$(basename "$dir")"; name="${base%-*}"; rev="${base##*-}"
  lic="$(find "$dir" -maxdepth 4 \( -iname 'LICENSE*' -o -iname 'COPYING*' \) | head -n 1)"
  if [ "$name" = ffmpeg ]; then id="LGPL-2.1-or-later"; src="https://git.ffmpeg.org/ffmpeg.git"; else id="BSD-3-Clause"; src="https://chromium.googlesource.com/chromium/src"; fi
  [ -n "$lic" ] || { echo "no license file in $dir" >&2; exit 1; }
  set -- "$@" --extra "playwright-$name@r$rev=$id=$lic=$src"
done
rm -rf licenses; mkdir licenses
node ../../scripts/third-party-notices.mjs --sbom "$WORK/sbom.json" --root "$WORK/app" \
  --out licenses/THIRD_PARTY_NOTICES.txt --sbom-out licenses/sbom.cdx.json \
  --title "defE2End desktop $VERSION ($TARGET)" "$@"
