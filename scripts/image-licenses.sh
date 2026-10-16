#!/bin/sh
# Builds one server image for one architecture with its SBOM and third-party notices in /licenses/ (stage 8
# contract section 3). The candidate image is built once, without cache; that same image is scanned with syft
# (OS packages, fonts, npm packages, binaries) and its file system read for license texts; the notices are then
# added as one more layer on top of it. So the SBOM describes exactly the image that is published, per
# architecture. Uses the plain docker builder (`docker build`), which sees the local candidate.
# Writes <out>/licenses/{sbom.cdx.json,THIRD_PARTY_NOTICES.txt} and <out>/files.txt (the image's file list, for
# the release clean-room check), and tags the result <tag>.
# Local trial runs may set IMAGE_LICENSES_KEEP_CACHE=1 to reuse the build cache (never in a release). Needs a
# builder with the docker driver (BUILDX_BUILDER=<name> picks one).
# Usage: scripts/image-licenses.sh <web|worker|migrate> <Dockerfile> <out dir> <platform> <tag> [label=value]...
set -eu
NAME="$1"; DOCKERFILE="$2"; OUT="$3"; PLATFORM="$4"; TAG="$5"; shift 5
VERSION="$(node -p 'require("./apps/web/package.json").version')"
CANDIDATE="defe2end-$NAME:candidate"
mkdir -p "$OUT/licenses"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; docker rm -f "defe2end-scan-$NAME" >/dev/null 2>&1 || true' EXIT

fresh="--no-cache --pull"; [ -n "${IMAGE_LICENSES_KEEP_CACHE:-}" ] && fresh="--pull=false"
# shellcheck disable=SC2086
docker build $fresh --platform "$PLATFORM" -t "$CANDIDATE" -f "$DOCKERFILE" .
syft scan "docker:$CANDIDATE" -q -o "cyclonedx-json=$WORK/sbom.json"
docker create --platform "$PLATFORM" --name "defe2end-scan-$NAME" "$CANDIDATE" >/dev/null
mkdir "$WORK/root"; docker export "defe2end-scan-$NAME" | tar -x -C "$WORK/root" 2>/dev/null || true
(cd "$WORK/root" && find . -xdev -type f | LC_ALL=C sort) > "$OUT/files.txt"

EXTRA=""
if [ "$NAME" = worker ]; then
  # Playwright's Chromium headless shell is a plain directory, not a package the scanner reports.
  shell="$(ls -d "$WORK"/root/ms-playwright/chromium_headless_shell-* | head -n 1)"
  rev="${shell##*-}"
  lic="$(find "$shell" -maxdepth 2 -iname 'LICENSE*' | head -n 1)"
  [ -n "$lic" ] || { echo "no license file in $shell" >&2; exit 1; }
  EXTRA="chromium-headless-shell@r$rev=BSD-3-Clause=$lic=https://chromium.googlesource.com/chromium/src"
fi
node scripts/third-party-notices.mjs --sbom "$WORK/sbom.json" --root "$WORK/root" \
  --out "$OUT/licenses/THIRD_PARTY_NOTICES.txt" --sbom-out "$OUT/licenses/sbom.cdx.json" \
  --title "defE2End $NAME image $VERSION ($PLATFORM)" ${EXTRA:+--extra "$EXTRA"}

# The notices layer on top of the scanned candidate, nothing rebuilt.
labels=""
for l in "$@"; do labels="$labels --label $l"; done
# shellcheck disable=SC2086
printf 'FROM %s\nCOPY . /licenses/\n' "$CANDIDATE" | docker build --pull=false --platform "$PLATFORM" $labels -t "$TAG" -f - "$OUT/licenses"
