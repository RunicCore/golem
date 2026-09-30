#!/usr/bin/env bash
# `bash ./dev.sh exec golem <tier> [args]` from the workspace root.
# golem has no services; the lifecycle commands exist so dev.sh up/down/logs
# skip it instead of looking for a compose file.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-help}" in
  manages-lifecycle|ready) exit 0 ;;
  lifecycle-up|lifecycle-down|lifecycle-logs|lifecycle-restart) echo "golem has no services; nothing to do." ;;
  lifecycle-running) exit 1 ;;
  help) echo "golem tiers: prepare, focused, full, acceptance, docs" ;;
  prepare|focused|full|acceptance|docs) exec bash "$here/scripts/test-runner/run.sh" "$@" ;;
  *) echo "Unknown golem command: $1" >&2; exit 2 ;;
esac
