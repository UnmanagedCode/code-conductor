#!/usr/bin/env bash
# Symlink node_modules from the parent repo into this worktree.
# Reason: Termux has flaky DNS that makes `npm install` fail unpredictably;
# reusing the parent's already-installed deps is far more reliable.

set -e

PARENT="${CC_PARENT_PATH:-../code-conductor}"

if [ -e node_modules ]; then
    echo "[post-worktree-create] node_modules already exists — skipping symlink."
    exit 0
fi

PARENT_NM="${PARENT}/node_modules"

if [ ! -d "$PARENT_NM" ]; then
    echo "[post-worktree-create] WARNING: ${PARENT_NM} not found; skipping symlink." >&2
    exit 0
fi

ln -s "$PARENT_NM" node_modules
echo "[post-worktree-create] Symlinked node_modules from ${PARENT_NM}."
