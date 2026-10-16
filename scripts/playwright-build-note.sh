#!/bin/sh
# The build note for a browser file Playwright downloads: which Playwright version and build revision it came
# with and, for ffmpeg, the configure flags recorded in the binary. Playwright publishes no build scripts for
# Chromium or ffmpeg in its repository at these versions, so the note records what the files themselves say.
# Usage: scripts/playwright-build-note.sh <chromium|chromium-headless-shell|ffmpeg> <revision> <playwright version> [ffmpeg binary]
set -eu
KIND="$1"; REV="$2"; PW="$3"
if [ "$KIND" = ffmpeg ]; then
  flags="$(LC_ALL=C grep -a -o -m1 -- '--pkg-config=[^[:cntrl:]]*' "$4" | head -n 1 | sed 's#--extra-cflags=[^ ]* ##; s#--extra-ldflags=[^ ]* ##; s#--prefix=[^ ]* ##; s#--bindir=[^ ]* ##')"
  echo "Built by Playwright $PW (ffmpeg build r$REV, https://github.com/microsoft/playwright/tree/v$PW) from the upstream tag, configured with: $flags"
else
  echo "Official Chromium-project build of this version, downloaded by Playwright $PW (browser revision r$REV, https://github.com/microsoft/playwright/tree/v$PW)"
fi
