#!/bin/sh
# Prints the latest stable release (X.Y.Z, from tags vX.Y.Z) older than HEAD, or nothing when there is none.
# CI passes it as UPGRADE_FROM_VERSION to deploy/test/upgrade.sh; empty means the base commit is used.
set -eu
current="$(git describe --tags --exact-match --match 'v[0-9]*' HEAD 2>/dev/null || true)"
git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | grep -vx "${current:-none}" | while read -r tag; do
  # Only tags already in HEAD's history: a release is "previous" only if this build descends from it.
  if git merge-base --is-ancestor "$tag" HEAD; then echo "${tag#v}"; break; fi
done
