#!/bin/sh
# Prints the latest published stable release (X.Y.Z) older than HEAD whose migrate image exists, or nothing.
# CI passes it as UPGRADE_FROM_VERSION to deploy/test/upgrade.sh; empty means the base commit is used.
# Drafts, prereleases and tags without a release are never picked. Needs `gh` (GH_TOKEN with read access is
# enough) and `docker manifest inspect`; when either is unavailable it prints nothing.
set -eu
IMAGE="${MIGRATE_IMAGE:-ghcr.io/97kim/defe2end-migrate}"
current="$(git describe --tags --exact-match --match 'v[0-9]*' HEAD 2>/dev/null || true)"
releases="$(gh release list --exclude-drafts --exclude-pre-releases --limit 100 --json tagName --jq '.[].tagName' 2>/dev/null || true)"
printf '%s\n' "$releases" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -rV | grep -vx "${current:-none}" |
  while read -r tag; do
    # Only releases already in HEAD's history, and only when their image was actually published.
    git merge-base --is-ancestor "$tag" HEAD 2>/dev/null || continue
    docker manifest inspect "$IMAGE:${tag#v}" >/dev/null 2>&1 || continue
    echo "${tag#v}"
    break
  done
