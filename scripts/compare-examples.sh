#!/usr/bin/env bash
# Compares the examples that `npm run generate:examples` writes for a base ref and for this worktree, and prints `diff -r --no-dereference base worktree`.
# Both trees generate in the golem test-runner container (the `examples` tier of scripts/test-runner/run.sh), so the host needs no
# node_modules. Run `npm run test:prepare` once after the runner image changes. A warm run of both trees takes about 1.5 minutes.
# Exit status: 0 the trees are the same, 1 they differ (the diff), 3 a generation failed (its log goes to stderr), 2 a lock or setup error.
# Both trees come from `git archive`, so both hold the tracked and the untracked files that .gitignore does not hide, and nothing else.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="${1:?usage: compare-examples.sh <base-ref>}"

# The folder sits in .cache (git-ignored, shared with Docker like the checkout), and the trap removes it.
mkdir -p "$root/.cache"
work="$(mktemp -d "$root/.cache/compare-examples.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# extract <git tree-ish> <folder>: its files, with no .git, git state or git-ignored file (so no generated file of an earlier run).
extract() {
  mkdir "$2"
  git -C "$root" archive "$1" | tar -x -C "$2"
}
# The tree of the worktree is built in a temporary index, so the real index stays as it is: HEAD, then every change, untracked and
# deleted file that .gitignore does not hide.
worktree_tree="$(export GIT_INDEX_FILE="$work/index"; git -C "$root" read-tree HEAD && git -C "$root" add -A && git -C "$root" write-tree)"
extract "$base" "$work/base-tree"
extract "$worktree_tree" "$work/worktree-tree"

# generate <source tree> <output folder>: the runner takes one run at a time, so a busy runner is waited for. Exit 2 is the runner's
# lock and setup errors (run.sh, the entrypoint); the entrypoint exits 3 for a failed generation.
generate() {
  local status
  for _ in $(seq 60); do
    status=0
    GOLEM_SOURCE_TREE="$1" bash "$root/scripts/test-runner/run.sh" examples >"$work/log" 2>&1 || status=$?
    grep -q 'holds /cache/run.lock' "$work/log" || break
    sleep 15
  done
  [ "$status" -eq 0 ] || { cat "$work/log" >&2; [ "$status" -eq 2 ] && exit 2; exit 3; }
  mv "$root/.cache/test-results/examples" "$2" || exit 3
}

echo "Generating the examples of $base ..." >&2
generate "$work/base-tree" "$work/base"
echo "Generating the examples of this worktree ..." >&2
generate "$work/worktree-tree" "$work/worktree"
cd "$work"
# The shared-folder example holds a folder link; following it makes macOS diff stop with "Directory loop detected".
diff -r --no-dereference base worktree
