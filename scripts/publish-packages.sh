#!/usr/bin/env bash
# Publishes the four golem packages to npm in dependency order. Run it after `npm run build && npm run build:scripts`:
# each package's prepack builds it again and runs the package checks.
#
#   publish-packages.sh publish [npm options]  publishes each package now, with the maintainer's two-factor sign-in.
#   publish-packages.sh stage [npm options]    stages each package (the Publish workflow); a maintainer approves each
#                                              one on npmjs.com or with `npm stage approve` before it is public.
#
# A version that is already on npm is skipped, so a run that stopped part way can run again.
# Pass --dry-run to see what would be published.
set -euo pipefail

case "${1:-}" in
  publish) command=(publish) ;;
  stage) command=(stage publish) ;;
  *) echo "usage: $0 publish|stage [npm options]" >&2; exit 2 ;;
esac
shift

cd "$(dirname "$0")/.."
for package in golem golem-model golem-openapi-ts golem-ts-openapi; do
  manifest="./packages/$package/package.json"
  name=$(node -p "require('$manifest').name")
  version=$(node -p "require('$manifest').version")
  # npm ignores publishConfig.tag when it publishes a workspace, so the package's publishConfig.tag is passed here.
  tag=$(node -p "require('$manifest').publishConfig.tag")
  if npm view "$name@$version" version > /dev/null 2>&1; then
    echo "$name@$version is already on npm; skipped."
  else
    npm "${command[@]}" --workspace "packages/$package" --tag "$tag" "$@"
  fi
done
