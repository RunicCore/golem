#!/usr/bin/env bash
# Runs one fe-deps test tier inside the test-runner container.
set -euo pipefail
tier="${1:?usage: fe-deps-test <prepare|focused|full|acceptance|docs> [args]}"

exec 9>/cache/run.lock
flock -n 9 || { echo "Another fe-deps test run holds /cache/run.lock; wait for it to finish." >&2; exit 2; }

mkdir -p /cache/work /cache/npm /cache/packed /cache/go /cache/gomod
# Copy the read-only source into the work tree, keeping mtimes so incremental
# builds stay warm. Build output and installs live only in the work tree.
rsync -a --delete \
  --exclude node_modules/ --exclude .build/ --exclude dist/ --exclude .cache/ \
  --exclude .git/ --exclude .private/ --exclude .superpowers/ --exclude .code-review-graph/ \
  --exclude .vitepress/cache/ --exclude .vitepress/dist/ \
  /src/ /cache/work/
cd /cache/work

export npm_config_cache=/cache/npm GOCACHE=/cache/go GOMODCACHE=/cache/gomod \
  FE_DEPS_PACKED_DIR=/cache/packed FE_DEPS_RESULTS_DIR=/results
export GOTOOLCHAIN=local
if [ "$tier" != prepare ]; then export npm_config_offline=true GOPROXY=off; fi

lock_hash="$(sha256sum package-lock.json | cut -c1-64)"
if [ "$(cat node_modules/.fe-deps-lock-hash 2>/dev/null || true)" != "$lock_hash" ]; then
  npm ci --no-audit --no-fund || {
    echo "npm ci failed. If npm reported ENOTCACHED, run: npm run test:prepare" >&2; exit 2; }
  echo "$lock_hash" > node_modules/.fe-deps-lock-hash
fi
npm run build:tests
# Run-level ceiling (F1: no run exceeds 10 min). --test-timeout only fails a
# test; a hung file process or a stuck await is ended here.
case "$tier" in
  focused) ceiling=180 ;; full) ceiling=450 ;; acceptance) ceiling=600 ;; docs) ceiling=300 ;; prepare) ceiling=1800 ;;
  *) ceiling=60 ;;
esac
status=0
timeout -k 30s "$ceiling" node .build/scripts/test-tier.js "$@" || status=$?
if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
  echo "The $tier tier exceeded its ${ceiling}s ceiling and was stopped." >&2
fi
exit "$status"
