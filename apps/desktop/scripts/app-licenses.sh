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
# Playwright (resolved through the runner, as scripts/fetch-browsers.mjs does) and its browsers.json: the real
# browser versions for each downloaded revision.
pwinfo() { node -e '
  const { createRequire } = require("node:module");
  const runner = createRequire(createRequire(process.cwd() + "/package.json").resolve("@defe2end/runner"));
  const pw = createRequire(runner.resolve("playwright/package.json"));
  const coreJson = pw.resolve("playwright-core/package.json");
  const core = require(coreJson);
  const b = require(require("node:path").join(require("node:path").dirname(coreJson), "browsers.json")).browsers.find((x) => x.name === process.argv[1] && x.revision === process.argv[2]);
  process.stdout.write(process.argv[1] === "version" ? core.version : (b?.browserVersion ?? ""));
' "$@"; }
PW_VERSION="$(pwinfo version)"
for dir in browsers/"$TARGET"/chromium-* browsers/"$TARGET"/ffmpeg-*; do
  [ -d "$dir" ] || continue
  base="$(basename "$dir")"; name="${base%-*}"; rev="${base##*-}"
  if [ "$name" = ffmpeg ]; then
    lic="$(find "$dir" -maxdepth 4 \( -iname 'LICENSE*' -o -iname 'COPYING*' \) | head -n 1)"
    [ -n "$lic" ] || { echo "no license file in $dir" >&2; exit 1; }
    # The binary names its source tag (nX.Y.Z) in its version string; read it without running the binary.
    bin="$(find "$dir" -maxdepth 2 -type f -name 'ffmpeg*' | head -n 1)"
    tag="$(LC_ALL=C grep -a -o -m1 'n[0-9][0-9.]*-playwright-build-[0-9]*' "$bin" | head -n 1 | cut -d- -f1)"
    [ -n "$tag" ] || { echo "no ffmpeg version in $bin" >&2; exit 1; }
    libs="$(sh ../../scripts/ffmpeg-libs.sh "$bin")"
    set -- "$@" --extra "$(echo "$libs" | sed -n 1p)" --extra "$(echo "$libs" | sed -n 2p)"
    set -- "$@" --extra "ffmpeg@${tag#n}=LGPL-2.1-or-later=$lic=https://git.ffmpeg.org/gitweb/ffmpeg.git/tree/refs/tags/$tag" \
      --extra-note "ffmpeg@${tag#n}=$(sh ../../scripts/playwright-build-note.sh ffmpeg "$rev" "$PW_VERSION" "$bin")"
  else
    # The browser build carries only its ABOUT notice (full credits are built into the browser); the Chromium
    # license of the same version comes from scripts/licenses/chromium@<version>.txt, copied from upstream.
    version="$(pwinfo chromium "$rev")"
    upstream="../../scripts/licenses/chromium@$version.txt"
    [ -n "$version" ] && [ -f "$upstream" ] || { echo "no Chromium license for version '$version' ($upstream); copy it from the Chromium source tag" >&2; exit 1; }
    mkdir -p "$WORK/chromium"
    cp "$upstream" "$WORK/chromium/LICENSE"
    about="$(find "$dir" -maxdepth 3 -name ABOUT | head -n 1)"
    [ -n "$about" ] && cp "$about" "$WORK/chromium/NOTICE.ABOUT"
    set -- "$@" --extra "chromium@$version=BSD-3-Clause=$WORK/chromium=https://chromium.googlesource.com/chromium/src/+/refs/tags/$version" \
      --extra-note "chromium@$version=$(sh ../../scripts/playwright-build-note.sh chromium "$rev" "$PW_VERSION" "$version")"
  fi
done
rm -rf licenses; mkdir licenses
node ../../scripts/third-party-notices.mjs --sbom "$WORK/sbom.json" --root "$WORK/app" \
  --out licenses/THIRD_PARTY_NOTICES.txt --sbom-out licenses/sbom.cdx.json \
  --title "defE2End desktop $VERSION ($TARGET)" "$@"
