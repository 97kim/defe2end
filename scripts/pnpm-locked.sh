#!/bin/sh
# Serialize pnpm runs that touch the shared lockfile when several people
# (or agents) work in the same checkout at once. mkdir is atomic.
lock="${TMPDIR:-/tmp}/defe2end-pnpm.lock"
until mkdir "$lock" 2>/dev/null; do sleep 2; done
trap 'rmdir "$lock"' EXIT INT TERM
corepack pnpm "$@"
