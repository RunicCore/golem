#!/usr/bin/env bash
# Host entry for fe-deps test tiers: checks the image, then runs one tier in it.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$root/scripts/test-runner"
tier="${1:?usage: run.sh <prepare|focused|full|acceptance|docs> [args]}"; shift
tag="fe-deps-test-runner:$(cat "$here/Dockerfile" "$here/entrypoint.sh" | shasum -a 256 | cut -c1-16)"
volume=fe-deps-test-cache
network=(--network none)
if [ "$tier" = prepare ]; then
  docker build --label org.exprtlabs.fe-deps-test=1 -t "$tag" "$here"
  network=()
elif ! docker image inspect "$tag" >/dev/null 2>&1; then
  echo "The fe-deps test image $tag is missing or out of date. Run: npm run test:prepare" >&2
  exit 2
fi
docker volume create --label org.exprtlabs.fe-deps-test=1 "$volume" >/dev/null
mkdir -p "$root/.cache/test-results"
tty=(); [ -t 1 ] && tty=(-t)
exec docker run --rm --init "${tty[@]}" "${network[@]}" \
  --label org.exprtlabs.fe-deps-test=1 \
  -v "$root:/src:ro" -v "$volume:/cache" -v "$root/.cache/test-results:/results" \
  -e PUBLIC_CONTENT_DENIED_TEXT -e PUBLIC_CONTENT_REQUIRE_DENIED_TEXT \
  "$tag" "$tier" "$@"
