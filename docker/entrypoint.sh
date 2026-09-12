#!/usr/bin/env bash
# code-conductor container entrypoint. Pre-flight checks turn environment
# problems into actionable FATALs instead of EACCES stack traces, repairs
# npm deps in the bind-mounted checkout if needed, then execs conductor.sh
# (what `npm start` runs).
set -euo pipefail

PROJECTS_ROOT="${PROJECTS_ROOT:-/workspaces/projects}"
REPO_DIR="${REPO_DIR:-/workspaces/code-conductor}"
export HOME="${CC_HOME_DIR:-${PROJECTS_ROOT}/.cc-home}"

fatal() { echo "FATAL (cc-entrypoint): $*" >&2; exit 1; }

# ── Pre-flight guards ────────────────────────────────────────────────────
# The checkout mount is present under either mount position (CC_MOUNT).
if [ ! -f "$REPO_DIR/server.ts" ]; then
  fatal "the cc checkout is not mounted at $REPO_DIR (expected $REPO_DIR/server.ts there). \
Check the repo bind mount and CC_MOUNT/CC_REPO_TARGET in docker/README.md."
fi

if [ ! -d "$PROJECTS_ROOT" ]; then
  fatal "the projects root $PROJECTS_ROOT does not exist on the host. Create it OUTSIDE the cc repo and make it writable by the CC_UID/CC_GID you run with: mkdir -p <dir> && chown <uid>:<gid> <dir>"
fi

if [ ! -w "$PROJECTS_ROOT" ]; then
  fatal "the projects root $PROJECTS_ROOT is not writable by uid $(id -u). chown it to the CC_UID/CC_GID configured in docker/.env (default 1000:1000)."
fi

# Boot readiness probe expects ~/.claude to exist; with the default HOME this
# is the first write into the projects root, so it needs the writability
# check above to have passed (an override CC_HOME_DIR needs its own parent).
mkdir -p "$HOME/.claude" 2>/dev/null || fatal "cannot create $HOME/.claude — make HOME ($HOME) writable by uid $(id -u) (default: chown the projects root to CC_UID/CC_GID)."

# The cc store must not sit inside a git repository: cc's own check
# (src/systems/sessionRoot.ts) refuses such placements at System registration
# time — late and obscure. Refuse here instead, boot-time. '.git' is a
# DIRECTORY in a normal checkout and a FILE in a worktree, so the test is
# existence, not kind.
d="$PROJECTS_ROOT"
while :; do
  if [ -e "$d/.git" ] || [ -L "$d/.git" ]; then
    fatal "the projects root ($PROJECTS_ROOT) is inside a git repository ('.git' at $d/.git). cc stores sessions, transcripts and settings under it and refuses such placements late; move the projects root outside the repo."
  fi
  [ "$d" = "/" ] && break
  d="$(dirname "$d")"
done

if [ ! -w "$REPO_DIR" ]; then
  fatal "the cc checkout $REPO_DIR is not writable by uid $(id -u); npm deps and server state are written into it."
fi

# Optional tooling vs runtime enablement: the CLI tooling alone is useless
# without the socket mount.
if [ "${CC_WITH_DOCKER:-0}" = "1" ] && [ ! -S /var/run/docker.sock ]; then
  echo "WARNING (cc-entrypoint): CC_WITH_DOCKER=1 but /var/run/docker.sock is not a socket in this container — add docker/compose.docker.yaml to the -f list (make up-docker-provider)." >&2
fi

# ── Deps, then exec ──────────────────────────────────────────────────────
cd "$REPO_DIR"

if ! node -e "require.resolve('express/package.json');require.resolve('ws/package.json')" >/dev/null 2>&1; then
  echo "node_modules incomplete — installing runtime deps" >&2
  # A git-worktree checkout can have a BROKEN node_modules symlink from the
  # host; drop the symlink only, never a real directory.
  if [ -L node_modules ]; then rm node_modules; fi
  if ! npm install --omit=dev --no-audit --no-fund; then
    fatal "npm could not install into $REPO_DIR/node_modules as uid $(id -u) — an existing node_modules there is likely not writable by you (e.g. root-owned from a run with the wrong CC_UID). chown it to this container's uid/gid, or remove it and re-up: rm -rf <checkout>/node_modules"
  fi
fi

exec ./conductor.sh "$@"