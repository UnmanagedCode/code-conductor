#!/usr/bin/env bash
# One headless cc run (`node server.ts --prompt …`) in a throwaway container:
# `docker compose run --rm` of the conductor service on a projects root of its
# own, printing cc's one JSON result on stdout and exiting with cc's exact code.
# `make headless` wraps this (make collapses any failure to 2); docker/README.md
# → Headless runs documents every variable.
#
# Reads: CC_HEADLESS_PROJECTS_DIR (required), CC_HEADLESS_PROMPT or PROMPT_FILE
# (exactly one; PROMPT_FILE=- reads stdin), MODE, CC_HEADLESS_HOME,
# CC_HEADLESS_PORT, CC_PROJECTS_DIR (the main service's), CC_BIND, CC_URL_HOST,
# DOCKER_COMPOSE, COMPOSE_FILES. Refusals exit 2 before compose runs.
set -uo pipefail

die() { echo "headless: $*" >&2; exit 2; }
# The physical path of an existing directory, or nothing.
canon_dir() { (cd "$1" 2>/dev/null && pwd -P); }
# A value as written in docker/.env: make's .env parsing keeps a surrounding
# quote pair and the whitespace before an inline comment, so strip surrounding
# whitespace, then one matching '…' or "…" pair. The prompt text is never
# normalised — it reaches cc verbatim.
norm() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  if [ "${#v}" -ge 2 ]; then
    case "$v" in
      \"*\") v="${v:1:${#v}-2}" ;;
      \'*\') v="${v:1:${#v}-2}" ;;
    esac
  fi
  printf '%s' "$v"
}
for var in CC_HEADLESS_PROJECTS_DIR CC_PROJECTS_DIR CC_HEADLESS_HOME CC_HEADLESS_PORT CC_BIND CC_URL_HOST PROMPT_FILE MODE DOCKER_COMPOSE; do
  printf -v "$var" '%s' "$(norm "${!var:-}")"
done

run_dir_in="${CC_HEADLESS_PROJECTS_DIR:-}"
[ -n "$run_dir_in" ] || die "CC_HEADLESS_PROJECTS_DIR is required: the projects root for this run, a directory of its own outside CC_PROJECTS_DIR"
run_dir="$(canon_dir "$run_dir_in")" || die "CC_HEADLESS_PROJECTS_DIR ($run_dir_in) is not an existing directory"
[ -n "$run_dir" ] || die "CC_HEADLESS_PROJECTS_DIR ($run_dir_in) is not an existing directory"

# Never skipped: a CC_PROJECTS_DIR that is set must resolve, or the run is refused.
if [ -n "$CC_PROJECTS_DIR" ]; then
  main_dir="$(canon_dir "$CC_PROJECTS_DIR")"
  [ -n "$main_dir" ] || die "CC_PROJECTS_DIR ($CC_PROJECTS_DIR) is not an existing directory; fix it in docker/.env or unset it"
  [ "$run_dir" = "$main_dir" ] && die "CC_HEADLESS_PROJECTS_DIR ($run_dir) is the main projects dir; give the run a projects root of its own"
  case "$run_dir/" in "${main_dir%/}"/*) die "CC_HEADLESS_PROJECTS_DIR ($run_dir) is inside the main projects dir ($main_dir); give the run a projects root outside it" ;; esac
  case "$main_dir/" in "${run_dir%/}"/*) die "CC_HEADLESS_PROJECTS_DIR ($run_dir) contains the main projects dir ($main_dir); give the run a projects root outside it" ;; esac
fi

prompt="${CC_HEADLESS_PROMPT:-}"
prompt_file="${PROMPT_FILE:-}"
[ -n "$prompt" ] && [ -n "$prompt_file" ] && die "give PROMPT or PROMPT_FILE, not both"
[ -n "$prompt" ] || [ -n "$prompt_file" ] || die "give PROMPT or PROMPT_FILE (PROMPT_FILE=- reads stdin)"

home="$CC_HEADLESS_HOME"
home_var=CC_HEADLESS_HOME
if [ -z "$home" ]; then
  [ -n "$CC_PROJECTS_DIR" ] || die "set CC_HEADLESS_HOME (the \$HOME holding the claude login) or CC_PROJECTS_DIR (whose .cc-home is the default)"
  home="${CC_PROJECTS_DIR%/}/.cc-home"
  home_var='$CC_PROJECTS_DIR/.cc-home'
fi
home_dir="$(canon_dir "$home")"
[ -n "$home_dir" ] || die "$home_var ($home) is not an existing directory; it is the run's \$HOME and must hold the claude login"
home="$home_dir"

run_args=(run --rm -T -v "$home:/workspaces/cc-home")
if [ -n "$prompt" ]; then
  cc_args=(--prompt "$prompt")
elif [ "$prompt_file" = "-" ]; then
  cc_args=(--prompt-file -)
else
  [ -f "$prompt_file" ] || die "PROMPT_FILE ($prompt_file) is not a file"
  prompt_path="$(canon_dir "$(dirname "$prompt_file")")/$(basename "$prompt_file")"
  run_args+=(-v "$prompt_path:/run/cc-prompt:ro")
  cc_args=(--prompt-file /run/cc-prompt)
fi
[ -n "${MODE:-}" ] && cc_args+=(--mode "$MODE")

if [ -n "${CC_HEADLESS_PORT:-}" ]; then
  bind="${CC_BIND:-127.0.0.1}"
  url_host="${CC_URL_HOST:-}"
  [ -n "$url_host" ] || url_host="$bind"
  [ "$url_host" = "0.0.0.0" ] && url_host=127.0.0.1
  run_args+=(-p "$bind:$CC_HEADLESS_PORT:8787")
  echo "headless: also published at http://$url_host:$CC_HEADLESS_PORT" >&2
fi

run_args+=(-e CC_WITH_TAILSCALE=0 -e CC_SKIP_DEPS_SYNC=1 conductor "${cc_args[@]}")

cd "$(dirname "$0")" || exit 2
# CC_PROJECTS_DIR rebinds the service's own /workspaces/projects volume (and
# HOST_PROJECTS_DIR); CC_HOME_DIR beats docker/.env's, so the run's HOME is the
# bind above. DOCKER_COMPOSE and COMPOSE_FILES split into words on purpose.
# shellcheck disable=SC2086
CC_PROJECTS_DIR="$run_dir" CC_HOME_DIR=/workspaces/cc-home \
  ${DOCKER_COMPOSE:-docker compose} ${COMPOSE_FILES:--f compose.yaml} "${run_args[@]}"
exit $?
