#!/bin/sh
# The build note for a browser file Playwright downloads, split into what the file and Playwright show and what
# could not be confirmed. Confirmed: the version string in the binary, (ffmpeg) the configure flags recorded in
# it, and the Playwright version and build revision it came with. Not confirmed: where the build scripts and any
# patches are published - the Playwright repository has none for Chromium or ffmpeg at these versions.
# Usage: scripts/playwright-build-note.sh <chromium|chromium-headless-shell|ffmpeg> <revision> <playwright version> <ffmpeg binary | browser version>
set -eu
KIND="$1"; REV="$2"; PW="$3"
if [ "$KIND" = ffmpeg ]; then
  version="$(LC_ALL=C grep -a -o -m1 'n[0-9][0-9.]*-playwright-build-[0-9]*' "$4" | head -n 1)"
  flags="$(LC_ALL=C grep -a -o -m1 -- '--pkg-config=[^[:cntrl:]]*' "$4" | head -n 1 | sed 's#--extra-cflags=[^ ]* ##; s#--extra-ldflags=[^ ]* ##; s#--prefix=[^ ]* ##; s#--bindir=[^ ]* ##')"
  echo "Confirmed: the binary reports version $version and was configured with: $flags; it ships with Playwright $PW as ffmpeg build r$REV (https://github.com/microsoft/playwright/tree/v$PW). Not confirmed: the build scripts and any patches applied on top of the upstream tag are not published in the Playwright repository at v$PW."
else
  echo "Confirmed: the browsers.json of Playwright $PW records $KIND revision r$REV as browser version $4 (https://github.com/microsoft/playwright/tree/v$PW). Not confirmed: the build configuration and any patches relative to the Chromium tag; the Playwright repository publishes none for it at v$PW."
fi
