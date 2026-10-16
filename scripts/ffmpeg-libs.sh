#!/bin/sh
# Prints the --extra specs (one per line, libvpx then zlib) for the libraries Playwright's ffmpeg build links
# statically. Versions are read from the binary's own strings; the license texts of those exact versions are kept
# in scripts/licenses/ (copied from upstream). Fails when a version can't be read or its text is missing.
# Usage: scripts/ffmpeg-libs.sh <ffmpeg binary>
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)/licenses"
BIN="$1"
vpx="$(LC_ALL=C grep -a -o -m1 'WebM Project VP9 Encoder v[0-9][0-9.]*' "$BIN" | head -n 1 | sed 's/.* v//; s/\.$//')"
zlib="$(LC_ALL=C grep -a -o -m1 'inflate [0-9][0-9.]* Copyright' "$BIN" | head -n 1 | cut -d' ' -f2)"
[ -n "$vpx" ] && [ -n "$zlib" ] || { echo "can't read the libvpx/zlib versions in $BIN" >&2; exit 1; }
for f in "libvpx@$vpx" "zlib@$zlib"; do
  [ -f "$DIR/$f.txt" ] || { echo "no license text $DIR/$f.txt; copy it from the upstream tag" >&2; exit 1; }
done
echo "libvpx@$vpx=BSD-3-Clause=$DIR/libvpx@$vpx.txt=https://chromium.googlesource.com/webm/libvpx/+/refs/tags/v$vpx"
echo "zlib@$zlib=Zlib=$DIR/zlib@$zlib.txt=https://github.com/madler/zlib/tree/v$zlib"
