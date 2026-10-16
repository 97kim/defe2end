#!/bin/sh
# SBOM and third-party notices for one server image, and the Dockerfile that bakes them into /licenses/
# (stage 8 contract section 3). Builds the image for one platform, scans the final image (OS packages, fonts,
# npm packages, binaries) with syft, collects license texts from its file system, and writes
# <Dockerfile>.release: the original with its last stage named `app`, plus a stage copying the `licenses` build
# context to /licenses/. The release build then runs <Dockerfile>.release with --build-context licenses=<out>.
# Also writes <out dir>.files.txt, the image's file list, for the release clean-room check.
# Usage: scripts/image-licenses.sh <web|worker|migrate> <Dockerfile> <out dir> [platform]   (from the repo root)
set -eu
NAME="$1"; DOCKERFILE="$2"; OUT="$3"; PLATFORM="${4:-linux/amd64}"
VERSION="$(node -p 'require("./package.json").version || require("./apps/web/package.json").version')"
mkdir -p "$OUT"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; docker rm -f "defe2end-scan-$NAME" >/dev/null 2>&1 || true' EXIT

awk -v last="$(grep -n '^FROM ' "$DOCKERFILE" | tail -n 1 | cut -d: -f1)" \
  'NR == last { print $0 " AS app"; next } { print }' "$DOCKERFILE" > "$DOCKERFILE.release"
printf '\n# Release only: SBOM and notices of this image (scripts/image-licenses.sh).\nFROM app\nCOPY --from=licenses / /licenses/\n' >> "$DOCKERFILE.release"
cp "$DOCKERFILE.dockerignore" "$DOCKERFILE.release.dockerignore"

docker buildx build --platform "$PLATFORM" --target app --load -t "defe2end-$NAME:scan" -f "$DOCKERFILE.release" .
syft scan "docker:defe2end-$NAME:scan" -q -o "cyclonedx-json=$WORK/sbom.json"
docker create --name "defe2end-scan-$NAME" "defe2end-$NAME:scan" >/dev/null
mkdir "$WORK/root"; docker export "defe2end-scan-$NAME" | tar -x -C "$WORK/root" 2>/dev/null || true

(cd "$WORK/root" && find . -xdev -type f | LC_ALL=C sort) > "$OUT.files.txt"

EXTRA=""
if [ "$NAME" = worker ]; then
  # Playwright's Chromium headless shell is a plain directory, not a package the scanner reports.
  shell="$(ls -d "$WORK"/root/ms-playwright/chromium_headless_shell-* | head -n 1)"
  rev="${shell##*-}"
  lic="$(find "$shell" -maxdepth 2 -iname 'LICENSE*' | head -n 1)"
  [ -n "$lic" ] || { echo "no license file in $shell" >&2; exit 1; }
  EXTRA="chromium-headless-shell@r$rev=BSD-3-Clause=$lic"
fi
node scripts/third-party-notices.mjs --sbom "$WORK/sbom.json" --root "$WORK/root" \
  --out "$OUT/THIRD_PARTY_NOTICES.txt" --sbom-out "$OUT/sbom.cdx.json" \
  --title "defE2End $NAME image $VERSION" ${EXTRA:+--extra "$EXTRA"}
