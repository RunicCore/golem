#!/usr/bin/env bash
# Publishes the four golem packages to npm in dependency order. Run it after `npm run build && npm run build:scripts`:
# each package's prepack builds it again and runs the package checks.
# A version that is already on npm is skipped, so a run that stopped part way can run again.
# Pass --dry-run to see what would be published.
set -euo pipefail

cd "$(dirname "$0")/.."
for package in golem golem-model golem-openapi-ts golem-ts-openapi; do
  manifest="./packages/$package/package.json"
  name=$(node -p "require('$manifest').name")
  version=$(node -p "require('$manifest').version")
  # npm ignores publishConfig.tag when it publishes a workspace, so the tag that release-version.ts set is passed here.
  tag=$(node -p "require('$manifest').publishConfig.tag")
  if npm view "$name@$version" version > /dev/null 2>&1; then
    echo "$name@$version is already on npm; skipped."
  else
    npm publish --workspace "packages/$package" --tag "$tag" "$@"
  fi
done
