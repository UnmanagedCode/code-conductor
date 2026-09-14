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

GPU ?= 0                # 1 → chain compose.gpu.yaml (host GPU for ollama; needs nvidia-container-toolkit)
CC_MOUNT ?= outside     # outside | inside — where the cc checkout binds (see docker/README.md)

# Recursively expanded so the target-specific variables set by GPU=1-style
# overrides are visible at recipe time; an ifeq at parse time would miss them.
# CC_WITH_SYSTEMS=1 and CC_WITH_DOCKER=1 each chain their override from here —
# one flag per feature turns on BOTH the tooling build and the runtime deltas.
# CC_COMPOSE_EXTRA comes LAST so an operator's own files win over the chain;
# it is a space-separated, unquoted list of paths relative to docker/.
COMPOSE_FILES = -f compose.yaml \
  $(if $(filter 1,$(CC_WITH_SYSTEMS)),-f compose.systems.yaml) \
  $(if $(filter 1,$(CC_WITH_DOCKER)),-f compose.docker.yaml) \
  $(if $(filter 1,$(GPU)),-f compose.gpu.yaml) \
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
.PHONY: build up down logs restart mount login login/tailscale base-image

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

up: base-image
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

# One-time tailscale join inside the running container: authenticate via the
# URL `tailscale up` prints, then approve the node in the browser. The node
# key persists across container recreation (<projects>/.cc-home/.tailscale).
login/tailscale:
	$(DOCKER_COMPOSE) $(COMPOSE_FILES) exec conductor tailscale up
