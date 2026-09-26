#!/usr/bin/env bash
# Symlink node_modules from the parent repo into this worktree.
# Reason: Termux has flaky DNS that makes `npm install` fail unpredictably;
# reusing the parent's already-installed deps is far more reliable.

set -e

PARENT="${CC_PARENT_PATH:?CC_PARENT_PATH is unset — cc passes it when it runs this hook (src/worktrees.ts)}"

PARENT_NM="${PARENT}/node_modules"

if [ -e node_modules ]; then
    echo "[post-worktree-create] node_modules already exists — skipping symlink."
elif [ ! -d "$PARENT_NM" ]; then
    echo "[post-worktree-create] WARNING: ${PARENT_NM} not found; skipping symlink." >&2
else
    ln -s "$PARENT_NM" node_modules
    echo "[post-worktree-create] Symlinked node_modules from ${PARENT_NM}."
fi

# Keep .wiki out of `git status`. info/exclude lives in the common git dir
# (`--git-path` resolves there from a worktree), so one entry covers the main
# checkout and every worktree. `/.wiki` has no trailing slash so it matches the
# symlink created below as well as the main checkout's directory.
EXCLUDE="$(git rev-parse --git-path info/exclude)"
if ! grep -qxF '/.wiki' "$EXCLUDE" 2>/dev/null; then
    mkdir -p "$(dirname "$EXCLUDE")"
    # Terminate a last line that lacks a newline so the entry isn't glued onto it.
    if [ -s "$EXCLUDE" ] && [ -n "$(tail -c1 "$EXCLUDE")" ]; then echo >> "$EXCLUDE"; fi
    echo '/.wiki' >> "$EXCLUDE"
    echo "[post-worktree-create] Added /.wiki to ${EXCLUDE}."
fi

# Symlink the out-of-tree wiki from the parent repo into this worktree.
PARENT_WIKI="${PARENT}/.wiki"

if [ -e .wiki ] || [ -L .wiki ]; then
    echo "[post-worktree-create] .wiki already exists — skipping symlink."
elif [ ! -d "$PARENT_WIKI" ]; then
    echo "[post-worktree-create] WARNING: ${PARENT_WIKI} not found; skipping .wiki symlink." >&2
else
    ln -s "$PARENT_WIKI" .wiki
    echo "[post-worktree-create] Symlinked .wiki from ${PARENT_WIKI}."
fi
