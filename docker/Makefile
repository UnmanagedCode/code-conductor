# Canonical invocation for the code-conductor docker deployment. All targets
# run from this directory (docker/) — or via `make -C docker <target>` — which
# is what makes .env auto-discovery work.

# Override for older setups: make DOCKER_COMPOSE=docker-compose  (or an
# exported DOCKER_COMPOSE env var — ?= won't override a defined env var).
DOCKER_COMPOSE ?= docker compose

# Plain docker, for the CC_BASE_IMAGE_FILE pre-build only — compose cannot
# build a bare Dockerfile that is not a service.
DOCKER ?= docker

# .env is compose's dotenv; make reads it too, so one flag per feature
# (CC_WITH_DOCKER, CC_WITH_SYSTEMS) drives both the tooling build and the
# compose -f chain. Only a COMMAND-LINE assignment overrides a value set here
# (make CC_WITH_SYSTEMS=1 up); an exported environment variable does NOT,
# because a definition in an included makefile beats the environment. Every
# make variable below is overridable from .env for the same reason.
-include .env

CC_GPU ?= 0             # 1 → chain compose.gpu.yaml (host GPU for ollama; needs nvidia-container-toolkit)
CC_MOUNT ?= outside     # outside | inside — where the cc checkout binds (see docker/README.md)

# Recursively expanded so the target-specific variables set by CC_GPU=1-style
# overrides are visible at recipe time; an ifeq at parse time would miss them.
# CC_WITH_SYSTEMS=1 and CC_WITH_DOCKER=1 each chain their override from here —
# one flag per feature turns on BOTH the tooling build and the runtime deltas.
# CC_COMPOSE_EXTRA comes LAST so an operator's own files win over the chain;
# it is a space-separated, unquoted list of paths relative to docker/.
COMPOSE_FILES = -f compose.yaml \
  $(if $(filter 1,$(CC_WITH_SYSTEMS)),-f compose.systems.yaml) \
  $(if $(filter 1,$(CC_WITH_DOCKER)),-f compose.docker.yaml) \
  $(if $(filter 1,$(CC_GPU)),-f compose.gpu.yaml) \
  $(foreach f,$(CC_COMPOSE_EXTRA),-f $(f))

ifneq ($(filter-out inside outside,$(CC_MOUNT)),)
$(warning CC_MOUNT='$(CC_MOUNT)' is not one of: inside outside — treating it as outside)
endif

# Resolve CC_MOUNT → the concrete container path, exported so compose
# interpolation picks it up for BOTH the bind target and the REPO_DIR env.
# A directly-set CC_REPO_TARGET wins (make CC_REPO_TARGET=/custom up, or an
# exported CC_REPO_TARGET) — the CC_MOUNT resolution only applies when
# CC_REPO_TARGET is unset.
ifeq ($(origin CC_REPO_TARGET),undefined)
CC_REPO_TARGET_RESOLVED = $(if $(filter inside,$(CC_MOUNT)),/workspaces/projects/code-conductor,/workspaces/code-conductor)
export CC_REPO_TARGET = $(CC_REPO_TARGET_RESOLVED)
endif

# With the Makefile, CC_MOUNT is the mount-position knob; a CC_REPO_TARGET in
# docker/.env IS read by make now (via -include above) and, being defined,
# wins over the CC_MOUNT resolution.

# CC_BASE_IMAGE_FILE: a Dockerfile pre-built here into CC_BASE_IMAGE_TAG and
# fed to the service build as its base. The build context is the directory
# CONTAINING that file (docker/.dockerignore does not apply — docker reads
# <context>/.dockerignore); a relative path resolves against docker/. It
# OVERWRITES CC_BASE_IMAGE, so the conflict must be captured before that.
CC_BASE_IMAGE_TAG ?= code-conductor-base:local
ifneq ($(CC_BASE_IMAGE_FILE),)
ifneq ($(CC_BASE_IMAGE),)
BASE_IMAGE_CONFLICT = 1
endif
export CC_BASE_IMAGE = $(CC_BASE_IMAGE_TAG)
endif

# CC_BASE_IMAGE: compose reads .env itself, so exporting is only needed to
# honor a command-line/exported value (make CC_BASE_IMAGE=… up); an empty or
# unset value is NOT exported, so compose's own default applies.
ifneq ($(CC_BASE_IMAGE),)
export CC_BASE_IMAGE
endif
.PHONY: build up down logs restart start stop mount login login/tailscale login/ollama base-image headless

# No-op unless CC_BASE_IMAGE_FILE is set. $(error) inside a recipe expands only
# when that recipe is about to run, so the conflict is fatal for build/up and
# harmless for down/logs/restart/login against a running stack.
base-image:
ifneq ($(CC_BASE_IMAGE_FILE),)
ifdef BASE_IMAGE_CONFLICT
	$(error CC_BASE_IMAGE and CC_BASE_IMAGE_FILE are both set — unset one in docker/.env)
endif
	$(DOCKER) build -f $(CC_BASE_IMAGE_FILE) -t $(CC_BASE_IMAGE_TAG) $(dir $(CC_BASE_IMAGE_FILE))
endif

build: base-image
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) build

# Mirrors compose.yaml's `${CC_BIND:-127.0.0.1}:${CC_PORT:-8787}:8787` port
# publish default exactly, so the URL `up` prints can't disagree with what
# was actually published. 0.0.0.0 (widen-deliberately) isn't a clickable
# host, so print loopback instead when bound wide open.
CC_BIND ?= 127.0.0.1
CC_PORT ?= 8787
CC_URL_HOST = $(if $(filter 0.0.0.0,$(CC_BIND)),127.0.0.1,$(CC_BIND))

up: base-image
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) up -d --build
	@echo "Reachable at: http://$(CC_URL_HOST):$(CC_PORT)$(if $(filter 0.0.0.0,$(CC_BIND)), (published on 0.0.0.0 — all interfaces),)"

down:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) down

logs:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) logs -f conductor

restart:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) restart conductor

# start/stop act on the existing conductor container without rebuilding or
# recreating it (make up rebuilds; make down removes it).
start:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) start conductor

stop:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) stop conductor

# Bind-mount a host directory into the RUNNING conductor container (no
# restart): make PROJECT=/x/y/project [ARGS=-r] mount. Needs host root, so
# the recipe sudo's; removal is the host-side nsenter one-liner in
# docker/README.md.
mount:
ifndef PROJECT
	$(error PROJECT is required: make PROJECT=/path/to/dir mount)
endif
	sudo python3 cc-mount.py "$(PROJECT)" $(ARGS)

# Sign in to claude inside the running container. The web UI's
# Settings → Account → Claude login runs the same command from the browser.
# `claude auth login` (not the REPL) is the most direct form: it starts the
# sign-in flow immediately; open the URL it prints on the host's browser.
# Credentials persist across container recreation ($HOME is on the host
# projects-root bind).
login:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) exec conductor claude auth login

# make HOSTNAME=<node-name> login/tailscale passes --hostname for that one
# invocation. Only origin `command line` (make HOSTNAME=... login/tailscale)
# or `file` (set in docker/.env, -include'd above) counts as deliberate;
# `environment`/`environment override` are ignored on purpose — HOSTNAME is
# commonly present as an ambient env var (e.g. inside containers), and honoring
# it would silently register the node under the host machine's name on a bare
# `make login/tailscale`.
ifneq ($(filter command line file,$(origin HOSTNAME)),)
TAILSCALE_HOSTNAME_ARG = --hostname=$(HOSTNAME)
endif

# One-time tailscale join inside the running container: authenticate via the
# URL `tailscale up` prints, then approve the node in the browser. The node
# key persists across container recreation (<projects>/.cc-home/.tailscale).
# Container hostname (CC_HOSTNAME in .env) is tailscale's default node name;
# HOSTNAME=<name> here overrides it for this one join.
login/tailscale:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) exec conductor tailscale up $(TAILSCALE_HOSTNAME_ARG)

# One-time sign-in to ollama's hosted service; needs CC_WITH_OLLAMA=1.
login/ollama:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) exec conductor ollama login

# One headless cc run in a throwaway container, on a projects root of its own:
#   make headless CC_HEADLESS_PROJECTS_DIR=/abs/dir PROMPT='…' | PROMPT_FILE=path|- [MODE=plan]
# A thin wrapper over docker/headless.sh, which holds the logic and exits with
# cc's exact code; make itself collapses any failure to 2 (the JSON on stdout
# carries the real `exitCode`). PROMPT is passed through $(value …) so make
# never expands a `$` in the prompt text. See docker/README.md → Headless runs.
headless: export CC_HEADLESS_PROMPT = $(value PROMPT)
headless: export PROMPT_FILE := $(value PROMPT_FILE)
headless: export MODE := $(value MODE)
headless: export CC_HEADLESS_PROJECTS_DIR := $(value CC_HEADLESS_PROJECTS_DIR)
headless: export CC_HEADLESS_HOME := $(value CC_HEADLESS_HOME)
headless: export CC_HEADLESS_PORT := $(value CC_HEADLESS_PORT)
headless: export CC_PROJECTS_DIR := $(CC_PROJECTS_DIR)
headless: export CC_BIND := $(CC_BIND)
headless: export CC_URL_HOST := $(CC_URL_HOST)
headless: export DOCKER_COMPOSE := $(DOCKER_COMPOSE)
headless: export COMPOSE_FILES := $(COMPOSE_FILES)
# Silent recipe and no Entering/Leaving lines, so stdout is cc's alone
# (`make headless | jq`). The directory lines of `make -C` are decided at parse
# time, so the flag is set there — only when `headless` is a goal, leaving
# every other target's output as it was.
ifneq ($(filter headless,$(MAKECMDGOALS)),)
MAKEFLAGS += --no-print-directory
endif
headless:
	@./headless.sh
