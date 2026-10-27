#!/usr/bin/env bash
# Runs one golem test tier inside the test-runner container.
set -euo pipefail
tier="${1:?usage: golem-test <prepare|focused|full|acceptance|docs> [args]}"

# Full and Acceptance take three options of the runner. --again runs the tier even when this tree passed it, and starts from zero
# instead of finishing a cut run. --load-limit and --load-wait set the host load check below.
again=0; load_limit=""; load_wait=""
if [ "$tier" = full ] || [ "$tier" = acceptance ]; then
  shift; rest=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --again) again=1 ;;
      --load-limit) load_limit="${2:?--load-limit takes a number}"; shift ;;
      --load-wait) load_wait="${2:?--load-wait takes a number}"; shift ;;
      *) rest+=("$1") ;;
    esac
    shift || true
  done
  set -- "$tier" ${rest[@]+"${rest[@]}"}
  for number in "$load_limit" "$load_wait"; do
    [ -z "$number" ] || [[ "$number" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "--load-limit and --load-wait take a number, got '$number'" >&2; exit 2; }
  done
fi

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

# The hash of the source tree that this run tests: the rsync'd files, without the folders that rsync leaves out, so builds and
# installs of earlier runs do not change it. It is the first part of the run key below. package-lock.json is the checked-in
# macOS one here; the Linux lockfile has its own part of the key.
tree_hash=""
if [ "$tier" = full ] || [ "$tier" = acceptance ]; then
  tree_hash="$(find . \( -name node_modules -o -name .build -o -name dist -o -name .cache -o -name .git -o -name .private -o -name .superpowers -o -name .code-review-graph \
    -o -path '*/.vitepress/cache' -o -path '*/.vitepress/dist' \) -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-32)"
fi

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
    "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "overrides", "workspaces",
    "packageManager"];
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

# A Full or Acceptance run is kept by the key of what it tests: the tier, the source tree, the runner image, the Linux lockfile
# (its slot and content) and the denied-text rules of the public-content scans. A tree that passed is not run again, and a run
# that the ceiling cut is finished by the next run of the same key (scripts/test-runner/run-state.ts). The records sit in the
# cache volume, so any checkout of the same tree finds them; those older than 14 days are removed.
if [ -n "$tree_hash" ]; then
  export GOLEM_RUN_TREE="$tree_hash" GOLEM_RUN_STATE="/cache/test-state/$tier"
  GOLEM_RUN_KEY="$(printf '%s\n' "$tier" "$tree_hash" "${GOLEM_IMAGE_TAG:-}" "$manifest_hash" "$lock_hash" "$(printf '%s' "${PUBLIC_CONTENT_DENIED_TEXT:-}" | sha256sum)" | sha256sum | cut -c1-32)"
  export GOLEM_RUN_KEY
  mkdir -p "$GOLEM_RUN_STATE"
  find "$GOLEM_RUN_STATE" -type f -mtime +14 -delete
  if [ "$again" -eq 1 ]; then
    export GOLEM_RUN_AGAIN=1
  elif [ -f "$GOLEM_RUN_STATE/$GOLEM_RUN_KEY.passed" ]; then
    echo "The $tier tier is not run: this tree already passed it. $(cat "$GOLEM_RUN_STATE/$GOLEM_RUN_KEY.passed")"
    echo "Run it anyway with --again."
    exit 0
  fi
fi
if [ "$(cat node_modules/.golem-lock-hash 2>/dev/null || true)" != "$lock_hash" ]; then
  npm ci --no-audit --no-fund || {
    echo "npm ci failed. If npm reported ENOTCACHED, run: npm run test:prepare" >&2; exit 2; }
  echo "$lock_hash" > node_modules/.golem-lock-hash
fi
npm run build:tests
# TypeScript 6 lane: its tests point GOLEM_TYPESCRIPT_ROOT at a project whose `typescript` is 6.x.
# It is installed once per spec into the cache volume. `prepare` fills the npm cache; other tiers install offline from it.
typescript6_root=/cache/typescript6
scripts/test-runner/install-typescript6.sh "$typescript6_root" || {
  echo "npm install of TypeScript 6 failed. Run: npm run test:prepare" >&2; exit 2; }
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
# Full and Acceptance wait for a quiet host: a load above the limit at the start leaves the run slower than its ceiling
# allows. The wait is here, before `timeout`, so it does not use the ceiling. The load is the 1 minute average of this kernel
# (on Docker Desktop, the Linux VM), the one the tier lines print. The defaults are one rule for every machine: the limit is
# the CPU count, because the unit step alone runs up to 8 files at once and so makes about that load; a start above it doubles a
# queue that is already full. The wait is 240 s; after it the run starts anyway.
if [ "$tier" = full ] || [ "$tier" = acceptance ]; then
  limit="${load_limit:-$(nproc)}"; bound="${load_wait:-240}"; waited=0
  while load="$(cut -d' ' -f1 /proc/loadavg)"; awk -v load="$load" -v limit="$limit" 'BEGIN { exit !(load > limit) }'; do
    if [ "$waited" -ge "$bound" ]; then echo "The $tier tier starts after waiting ${waited}s: load (container kernel) is $load, above the limit $limit."; break; fi
    [ "$waited" -gt 0 ] || echo "The $tier tier waits up to ${bound}s for load (container kernel) $load to fall to $limit or less."
    sleep 10; waited=$((waited + 10))
  done
  [ "$waited" -eq 0 ] || [ "$waited" -ge "$bound" ] || echo "The $tier tier starts after waiting ${waited}s: load (container kernel) is $load."
fi
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
  if [ -n "$tree_hash" ]; then
    node -e "import('./.build/scripts/test-runner/run-state.js').then(({ recordCut }) => console.error(recordCut(process.argv[1], process.argv[2], Number(process.argv[3]))))" /results "$tier" "$ceiling" \
      || echo "Could not keep the cut run for a resume." >&2
  fi
fi
exit "$status"
