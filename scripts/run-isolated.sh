#!/usr/bin/env bash
# Start this checkout fully isolated from any other cc instance on the machine:
# own projects root (store, .plugins, .worktrees), own Claude config dir, own port.
# Env: PORT (required), CC_ISOLATED_ROOT (default /tmp/cc-rework-root), HOST.
set -euo pipefail
: "${PORT:?PORT must be set}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="${CC_ISOLATED_ROOT:-/tmp/cc-rework-root}"
mkdir -p "$root/projects" "$root/claude-config"
export PROJECTS_ROOT="$root/projects"
export CLAUDE_CONFIG_DIR="$root/claude-config"
export HOST="${HOST:-127.0.0.1}"
cd "$repo"
exec node server.ts
