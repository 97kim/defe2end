#!/bin/sh
# Prints the latest published stable release (X.Y.Z) older than HEAD whose migrate image exists, or nothing.
# CI passes it as UPGRADE_FROM_VERSION to deploy/test/upgrade.sh; empty means the base commit is used.
# Drafts, prereleases and tags without a release are never picked. Needs `gh` (GH_TOKEN with read access is
# enough), `docker manifest inspect` and the release tags in the local clone.
# Empty output only when the lookups worked and found nothing. A failed lookup (no access, outage, missing tag)
# exits non-zero instead, so the upgrade test never falls back to the base commit by accident.
set -eu
IMAGE="${MIGRATE_IMAGE:-ghcr.io/97kim/defe2end-migrate}"
fail() { echo "previous-release: $*" >&2; exit 1; }
current="$(git describe --tags --exact-match --match 'v[0-9]*' HEAD 2>/dev/null || true)"
releases="$(gh release list --exclude-drafts --exclude-pre-releases --limit 100 --json tagName --jq '.[].tagName')" ||
  fail "could not list releases"
for tag in $(printf '%s\n' "$releases" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -rV | grep -vx "${current:-none}" || true); do
  # Only releases already in HEAD's history (1 = not an ancestor; anything else, e.g. a missing tag, is an error).
  status=0; git merge-base --is-ancestor "$tag" HEAD 2>/dev/null || status=$?
  [ "$status" -eq 1 ] && continue
  [ "$status" -eq 0 ] || fail "can't check $tag against HEAD (is the tag fetched?)"
  # Only when its image was actually published; "not found" skips it, any other error fails.
  if ! out="$(docker manifest inspect "$IMAGE:${tag#v}" 2>&1 >/dev/null)"; then
    case "$out" in
      *"no such manifest"*|*"manifest unknown"*|*"not found"*) continue ;;
      *) fail "could not look up $IMAGE:${tag#v}: $out" ;;
    esac
  fi
  echo "${tag#v}"
  exit 0
done
