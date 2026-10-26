#!/usr/bin/env bash
# Installs the TypeScript 6 spec of scripts/third-party-installs.ts into <root>, once per spec.
# The container entrypoint and the CI unit job both call it. It needs `.build/scripts` (npm run build:scripts).
set -euo pipefail
root="${1:?usage: install-typescript6.sh <root>}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
spec="$(cd "$repo" && node -e "import('./.build/scripts/third-party-installs.js').then(({ TYPESCRIPT6 }) => process.stdout.write(TYPESCRIPT6))")"
[ "$(cat "$root/.spec" 2>/dev/null || true)" = "$spec" ] && exit 0
rm -rf "$root"
mkdir -p "$root"
echo '{ "private": true }' > "$root/package.json"
(cd "$root" && npm install --ignore-scripts --no-audit --no-fund "$spec") >&2 || { rm -rf "$root"; exit 1; }
echo "$spec" > "$root/.spec"
