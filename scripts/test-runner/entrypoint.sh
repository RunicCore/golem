#!/usr/bin/env bash
# Runs one golem test tier inside the test-runner container.
set -euo pipefail
tier="${1:?usage: golem-test <prepare|focused|full|acceptance|docs> [args]}"

exec 9>/cache/run.lock
flock -n 9 || { echo "Another golem test run holds /cache/run.lock; wait for it to finish." >&2; exit 2; }

mkdir -p /cache/work /cache/npm /cache/packed /cache/linux-lock /cache/ttsc /cache/gomod
# Copy the read-only source into the work tree, keeping mtimes so incremental
# builds stay warm. Build output and installs live only in the work tree.
rsync -a --delete \
  --exclude node_modules/ --exclude .build/ --exclude dist/ --exclude .cache/ \
  --exclude .git/ --exclude .private/ --exclude .superpowers/ --exclude .code-review-graph/ \
  --exclude .vitepress/cache/ --exclude .vitepress/dist/ \
  /src/ /cache/work/
cd /cache/work

export npm_config_cache=/cache/npm \
  FE_DEPS_PACKED_DIR=/cache/packed FE_DEPS_RESULTS_DIR=/results \
  TTSC_CACHE_DIR=/cache/ttsc GOMODCACHE=/cache/gomod
if [ "$tier" != prepare ]; then export npm_config_offline=true GOPROXY=off; fi

# The checked-in package-lock.json is generated on macOS and lacks the Linux
# platform binaries (typescript, esbuild, rollup). The container resolves its
# own Linux lockfile online during `prepare` and keeps it in the cache volume.
# The checked-in lockfile is never edited. rsync restores it on every run, so copy each time.
#
# The slot is named by a hash of the fields of each package.json that change the
# install (see install_fields). A change to scripts, files, exports or any other field
# keeps the slot. Each hash has its own folder, so branches with different
# dependencies never overwrite each other. The older single slot
# (/cache/linux-lock/package-lock.json and manifests.sha256) is neither read nor
# written: a branch that still runs the old entrypoint keeps using it.
linux_lock=/cache/linux-lock
manifest_hash="$(node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const install_fields = ["name", "version", "dependencies", "devDependencies", "optionalDependencies",
    "peerDependencies", "overrides", "workspaces", "packageManager"];
  const sorted = (value) => Array.isArray(value) ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
      : value;
  const hash = crypto.createHash("sha256");
  for (const file of process.argv.slice(1).sort()) {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const picked = Object.fromEntries(install_fields.filter((field) => field in manifest).map((field) => [field, sorted(manifest[field])]));
    hash.update(JSON.stringify([file, picked]) + "\n");
  }
  process.stdout.write(hash.digest("hex").slice(0, 32));
' package.json packages/*/package.json examples/payments/package.json)"
lock_slot="$linux_lock/deps-$manifest_hash"
if [ -f "$lock_slot/package-lock.json" ]; then
  cp "$lock_slot/package-lock.json" package-lock.json
elif [ "$tier" = prepare ]; then
  rm -rf package-lock.json node_modules packages/*/node_modules examples/*/node_modules
  npm install --no-audit --no-fund || {
    echo "npm install failed while resolving the Linux lockfile; check the network and run: npm run test:prepare" >&2; exit 2; }
  # Written whole through a temporary file, so a kill never leaves half a slot.
  mkdir -p "$lock_slot"
  cp package-lock.json "$lock_slot/package-lock.json.tmp"
  mv "$lock_slot/package-lock.json.tmp" "$lock_slot/package-lock.json"
else
  echo "No Linux lockfile for the current package.json files. Run: npm run test:prepare" >&2
  exit 2
fi

lock_hash="$(sha256sum package-lock.json | cut -c1-64)"
if [ "$(cat node_modules/.golem-lock-hash 2>/dev/null || true)" != "$lock_hash" ]; then
  npm ci --no-audit --no-fund || {
    echo "npm ci failed. If npm reported ENOTCACHED, run: npm run test:prepare" >&2; exit 2; }
  echo "$lock_hash" > node_modules/.golem-lock-hash
fi
npm run build:tests
# TypeScript 6 lane: its tests point GOLEM_TYPESCRIPT_ROOT at a project whose `typescript` is 6.x.
# It is installed once per spec into the cache volume. `prepare` fills the npm cache; other tiers install offline from it.
typescript6_spec="$(node -e "import('./.build/scripts/third-party-installs.js').then(({ TYPESCRIPT6 }) => process.stdout.write(TYPESCRIPT6))")"
typescript6_root=/cache/typescript6
if [ "$(cat "$typescript6_root/.spec" 2>/dev/null || true)" != "$typescript6_spec" ]; then
  rm -rf "$typescript6_root"
  mkdir -p "$typescript6_root"
  echo '{ "private": true }' > "$typescript6_root/package.json"
  (cd "$typescript6_root" && npm install --ignore-scripts --no-audit --no-fund "$typescript6_spec") || {
    rm -rf "$typescript6_root"
    echo "npm install $typescript6_spec failed. Run: npm run test:prepare" >&2; exit 2; }
  echo "$typescript6_spec" > "$typescript6_root/.spec"
fi
export GOLEM_TYPESCRIPT6_ROOT="$typescript6_root"
# npm ci ran before packages/*/dist existed, so workspace bins (golem) were not linked; link them now, without lifecycle scripts.
npm rebuild --ignore-scripts --no-audit --no-fund
# Run-level ceiling (F1: no run exceeds 10 min). It is the one hang catcher: a test step passes no
# per-file or per-test limit, so a loaded host does not fail a file that works. A hung file process or a
# stuck await is ended here, and the files that started and did not finish are named below.
case "$tier" in
  focused) ceiling=180 ;; full) ceiling=450 ;; acceptance) ceiling=600 ;; docs) ceiling=300 ;; prepare) ceiling=300 ;;
  *) ceiling=60 ;;
esac
status=0
# timeout puts the tier in its own process group, so a Ctrl-C or docker stop
# reaches only this shell. Pass it on; timeout forwards it to the tier.
timeout -k 30s "$ceiling" node .build/scripts/test-tier.js "$@" &
tier_pid=$!
trap 'kill -INT "$tier_pid" 2>/dev/null || true' INT
trap 'kill -TERM "$tier_pid" 2>/dev/null || true' TERM
while :; do
  wait "$tier_pid" && status=0 || status=$?
  kill -0 "$tier_pid" 2>/dev/null || break
done
if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
  echo "The $tier tier exceeded its ${ceiling}s ceiling and was stopped." >&2
  node -e "import('./.build/scripts/test-file-timings.js').then(({ ceilingReport }) => console.error(ceilingReport(process.argv[1], process.argv[2])))" /results "$tier" \
    || echo "Could not name the unfinished files from /results." >&2
fi
exit "$status"
