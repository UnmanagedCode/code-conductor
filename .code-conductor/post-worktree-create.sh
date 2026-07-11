#!/usr/bin/env bash
# Symlink node_modules from the parent repo into this worktree.
# Reason: Termux has flaky DNS that makes `npm install` fail unpredictably;
# reusing the parent's already-installed deps is far more reliable.

set -e

PARENT="${CC_PARENT_PATH:-../code-conductor}"

PARENT_NM="${PARENT}/node_modules"

if [ -e node_modules ]; then
    echo "[post-worktree-create] node_modules already exists — skipping symlink."
elif [ ! -d "$PARENT_NM" ]; then
    echo "[post-worktree-create] WARNING: ${PARENT_NM} not found; skipping symlink." >&2
else
    ln -s "$PARENT_NM" node_modules
    echo "[post-worktree-create] Symlinked node_modules from ${PARENT_NM}."
fi

# Symlink the out-of-tree wiki from the parent repo into this worktree.
# .git/info/exclude is shared across all worktrees (it lives in the common
# git dir), so the parent's existing ".wiki" exclude entry already covers
# every worktree — nothing to add here.
PARENT_WIKI="${PARENT}/.wiki"

if [ -e .wiki ] || [ -L .wiki ]; then
    echo "[post-worktree-create] .wiki already exists — skipping symlink."
elif [ ! -d "$PARENT_WIKI" ]; then
    echo "[post-worktree-create] WARNING: ${PARENT_WIKI} not found; skipping .wiki symlink." >&2
else
    ln -s "$PARENT_WIKI" .wiki
    echo "[post-worktree-create] Symlinked .wiki from ${PARENT_WIKI}."
fi
