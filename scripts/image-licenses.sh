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
if [ "$NAME" = web ]; then
  # The web image keeps only the files the server traces, without license texts: they are read from the build
  # stage, built first (same job, so the candidate below reuses these layers rather than rebuilding them).
  # shellcheck disable=SC2086
  docker build $fresh --platform "$PLATFORM" --target build -t "defe2end-$NAME:build" -f "$DOCKERFILE" .
  fresh="--pull=false"
fi
# shellcheck disable=SC2086
docker build $fresh --platform "$PLATFORM" -t "$CANDIDATE" -f "$DOCKERFILE" .
syft scan "docker:$CANDIDATE" -q -o "cyclonedx-json=$WORK/sbom.json"
docker create --platform "$PLATFORM" --name "defe2end-scan-$NAME" "$CANDIDATE" >/dev/null
mkdir "$WORK/root"; docker export "defe2end-scan-$NAME" | tar -x -C "$WORK/root" 2>/dev/null || true
(cd "$WORK/root" && find . -xdev -type f | LC_ALL=C sort) > "$OUT/files.txt"

TEXTS=""
if [ "$NAME" = web ]; then
  mkdir "$WORK/texts"
  docker run --rm --platform "$PLATFORM" --entrypoint sh "defe2end-$NAME:build" -c \
    'cd /repo && find node_modules -type f \( -iname "*licen[cs]e*" -o -iname "copying*" -o -iname "*notice*" \) | tar -cf - -T -' \
    | tar -x -C "$WORK/texts"
  TEXTS="$WORK/texts"
fi

EXTRA=""; EXTRA2=""
if [ "$NAME" = worker ]; then
  # Playwright's Chromium headless shell is a plain directory, not a package the scanner reports.
  shell="$(ls -d "$WORK"/root/ms-playwright/chromium_headless_shell-* | head -n 1)"
  rev="${shell##*-}"
  lic="$(find "$shell" -maxdepth 2 -iname 'LICENSE*' | head -n 1)"
  [ -n "$lic" ] || { echo "no license file in $shell" >&2; exit 1; }
  EXTRA="chromium-headless-shell@r$rev=BSD-3-Clause=$lic=https://chromium.googlesource.com/chromium/src"
  # Playwright's ffmpeg (video recording) comes along with the browser install; its binary names its source tag.
  ff="$(ls -d "$WORK"/root/ms-playwright/ffmpeg-* 2>/dev/null | head -n 1)"
  if [ -n "$ff" ]; then
    fflic="$(find "$ff" -maxdepth 1 -iname 'COPYING*' | head -n 1)"
    tag="$(LC_ALL=C grep -a -o -m1 'n[0-9][0-9.]*-playwright-build-[0-9]*' "$ff"/ffmpeg-* | head -n 1 | cut -d- -f1)"
    [ -n "$fflic" ] && [ -n "$tag" ] || { echo "no license or version for $ff" >&2; exit 1; }
    EXTRA2="ffmpeg@${tag#n}=LGPL-2.1-or-later=$fflic=https://git.ffmpeg.org/gitweb/ffmpeg.git/tree/refs/tags/$tag"
  fi
fi
node scripts/third-party-notices.mjs --sbom "$WORK/sbom.json" --root "$WORK/root" \
  --out "$OUT/licenses/THIRD_PARTY_NOTICES.txt" --sbom-out "$OUT/licenses/sbom.cdx.json" \
  --title "defE2End $NAME image $VERSION ($PLATFORM)" ${EXTRA:+--extra "$EXTRA"} ${EXTRA2:+--extra "$EXTRA2"} ${TEXTS:+--texts-root "$TEXTS"}

# The notices layer on top of the scanned candidate, nothing rebuilt.
labels=""
for l in "$@"; do labels="$labels --label $l"; done
# shellcheck disable=SC2086
printf 'FROM %s\nCOPY . /licenses/\n' "$CANDIDATE" | docker build --pull=false --platform "$PLATFORM" $labels -t "$TAG" -f - "$OUT/licenses"
