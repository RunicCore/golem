#!/usr/bin/env bash
# `bash ./dev.sh exec fe-deps <tier> [args]` from the workspace root.
# fe-deps has no services; the lifecycle commands exist so dev.sh up/down/logs
# skip it instead of looking for a compose file.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-help}" in
  manages-lifecycle|ready) exit 0 ;;
  lifecycle-up|lifecycle-down|lifecycle-logs|lifecycle-restart) echo "fe-deps has no services; nothing to do." ;;
  lifecycle-running) exit 1 ;;
  help) echo "fe-deps tiers: prepare, focused, full, acceptance, docs" ;;
  prepare|focused|full|acceptance|docs) exec bash "$here/scripts/test-runner/run.sh" "$@" ;;
  *) echo "Unknown fe-deps command: $1" >&2; exit 2 ;;
esac
