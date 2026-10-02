#!/usr/bin/env bash
# Host entry for golem test tiers: checks the image, then runs one tier in it.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$root/scripts/test-runner"
tier="${1:?usage: run.sh <prepare|focused|full|acceptance|docs> [args]}"; shift
tag="golem-test-runner:$(cat "$here/Dockerfile" "$here/entrypoint.sh" | shasum -a 256 | cut -c1-16)"
volume=golem-test-cache
network=(--network none)
if [ "$tier" = prepare ]; then
  docker build --label org.exprtlabs.golem-test=1 -t "$tag" "$here"
  network=()
elif ! docker image inspect "$tag" >/dev/null 2>&1; then
  echo "The golem test image $tag is missing or out of date. Run: npm run test:prepare" >&2
  exit 2
fi
docker volume create --label org.exprtlabs.golem-test=1 "$volume" >/dev/null
# The public-content scans read local denied text from .private/, which the
# container's work tree leaves out. Pass it in the environment, never as a file.
rules="$root/.private/public-content.json"
if [ -f "$rules" ]; then
  local_denied="$(node -e '
    const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(value.deniedText) || !value.deniedText.every(item => typeof item === "string")) process.exit(3);
    process.stdout.write(value.deniedText.join("\n"));' "$rules")" || { echo "Invalid local public-content rules: $rules" >&2; exit 2; }
  export PUBLIC_CONTENT_DENIED_TEXT="${PUBLIC_CONTENT_DENIED_TEXT:+$PUBLIC_CONTENT_DENIED_TEXT
}$local_denied"
fi
mkdir -p "$root/.cache/test-results"
tty=(); [ -t 1 ] && tty=(-t)
exec docker run --rm --init ${tty[@]+"${tty[@]}"} ${network[@]+"${network[@]}"} \
  --label org.exprtlabs.golem-test=1 \
  -e TINI_KILL_PROCESS_GROUP=1 \
  -v "$root:/src:ro" -v "$volume:/cache" -v "$root/.cache/test-results:/results" \
  -e PUBLIC_CONTENT_DENIED_TEXT -e PUBLIC_CONTENT_REQUIRE_DENIED_TEXT \
  -e GOLEM_TYPESCRIPT_ROOT \
  "$tag" "$tier" "$@"
