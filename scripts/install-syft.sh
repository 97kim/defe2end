#!/bin/sh
# Installs a pinned syft (SBOM scanner, Apache-2.0) into $1 (default ./.bin), checked against the release's
# checksum list. Linux, macOS and Windows (Git Bash) runners.
set -eu
VERSION=1.54.1
DEST="${1:-.bin}"
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; MINGW*|MSYS*) os=windows ;; *) echo "unsupported OS" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
ext=tar.gz; [ "$os" = windows ] && ext=zip
asset="syft_${VERSION}_${os}_${arch}.$ext"
base="https://github.com/anchore/syft/releases/download/v$VERSION"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$asset" "$base/$asset"
curl -fsSL -o "$tmp/checksums.txt" "$base/syft_${VERSION}_checksums.txt"
(cd "$tmp" && grep " $asset\$" checksums.txt | { if command -v sha256sum >/dev/null; then sha256sum -c -; else shasum -a 256 -c -; fi; })
mkdir -p "$DEST"
if [ "$ext" = zip ]; then unzip -q -o "$tmp/$asset" syft.exe -d "$DEST"; else tar -xzf "$tmp/$asset" -C "$DEST" syft; fi
# Prints the directory for $GITHUB_PATH (a Windows path under Git Bash).
if command -v cygpath >/dev/null; then cygpath -w "$(cd "$DEST" && pwd)"; else (cd "$DEST" && pwd); fi
