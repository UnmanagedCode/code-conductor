# Canonical invocation for the code-conductor docker deployment. All targets
# run from this directory (docker/) — or via `make -C docker <target>` — which
# is what makes .env auto-discovery work.

# Override for older setups: make DOCKER_COMPOSE=docker-compose  (or an
# exported DOCKER_COMPOSE env var — ?= won't override a defined env var).
DOCKER_COMPOSE ?= docker compose

# .env is compose's dotenv; make reads it too, so one flag (CC_WITH_DOCKER)
# drives both the tooling build and the socket-mount chain. A command-line or
# exported variable wins over the .env value (make's own definitions beat an
# included file's).
-include .env

SYSTEMS ?= 0            # 1 → chain compose.systems.yaml (/dev/fuse + SYS_ADMIN + apparmor)
GPU ?= 0                # 1 → chain compose.gpu.yaml (host GPU for ollama; needs nvidia-container-toolkit)
CC_MOUNT ?= outside     # outside | inside — where the cc checkout binds (see docker/README.md)

# Recursively expanded so the target-specific variables set by up-systems /
# GPU=1-style overrides are visible at recipe time; an ifeq at parse time
# would miss them. CC_WITH_DOCKER=1 chains compose.docker.yaml from here —
# one flag turns on BOTH the docker.io tooling build and the socket mount.
COMPOSE_FILES = -f compose.yaml \
  $(if $(filter 1,$(SYSTEMS)),-f compose.systems.yaml) \
  $(if $(filter 1,$(CC_WITH_DOCKER)),-f compose.docker.yaml) \
  $(if $(filter 1,$(GPU)),-f compose.gpu.yaml)

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

# CC_BASE_IMAGE: compose reads .env itself, so exporting is only needed to
# honor a command-line/exported value (make CC_BASE_IMAGE=… up); an empty or
# unset value is NOT exported, so compose's own default applies.
ifneq ($(CC_BASE_IMAGE),)
export CC_BASE_IMAGE
endif
.PHONY: build up down logs restart mount login up-systems

build:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) build

up:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) up -d --build

down:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) down

logs:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) logs -f conductor

restart:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) restart conductor

# Bind-mount a host directory into the RUNNING conductor container (no
# restart): make PROJECT=/x/y/project [ARGS=-r] mount. Needs host root, so
# the recipe sudo's; removal is the host-side nsenter one-liner in
# docker/README.md.
mount:
ifndef PROJECT
	$(error PROJECT is required: make PROJECT=/path/to/dir mount)
endif
	sudo python3 cc-mount.py "$(PROJECT)" $(ARGS)

# Sign in to claude inside the running container — the primary auth flow.
# `claude auth login` (not the REPL) is the most direct form: it starts the
# sign-in flow immediately; open the URL it prints on the host's browser.
# Credentials persist across container recreation ($HOME is on the host
# projects-root bind).
login:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) exec conductor claude auth login

# Convenience aliases: target-specific variables are inherited by their
# prerequisites, so `up-systems: up` runs `up` with SYSTEMS=1 in effect.
up-systems: SYSTEMS = 1
up-systems: up