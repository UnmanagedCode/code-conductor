# Canonical invocation for the code-conductor docker deployment. All targets
# run from this directory (docker/) — or via `make -C docker <target>` — which
# is what makes .env auto-discovery work.

# Override for older setups: make DOCKER_COMPOSE=docker-compose  (or an
# exported DOCKER_COMPOSE env var — ?= won't override a defined env var).
DOCKER_COMPOSE ?= docker compose

SYSTEMS ?= 0            # 1 → chain compose.systems.yaml (/dev/fuse + SYS_ADMIN + apparmor)
DOCKER_PROVIDER ?= 0    # 1 → chain compose.docker.yaml (docker.sock; pair with CC_WITH_DOCKERIO=1)
GPU ?= 0                # 1 → chain compose.gpu.yaml (host GPU for ollama; needs nvidia-container-toolkit)
CC_MOUNT ?= outside     # outside | inside — where the cc checkout binds (see docker/README.md)

# Recursively expanded so the target-specific variables set by up-systems /
# up-docker-provider / GPU=1-style overrides are visible at recipe time; an
# ifeq at parse time would miss them.
COMPOSE_FILES = -f compose.yaml \
  $(if $(filter 1,$(SYSTEMS)),-f compose.systems.yaml) \
  $(if $(filter 1,$(DOCKER_PROVIDER)),-f compose.docker.yaml) \
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
# docker/.env is NOT read by make and is ignored by this resolution — set
# CC_REPO_TARGET on the make command line or in the environment instead.
.PHONY: build up down logs restart up-systems up-docker-provider

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

# Convenience aliases: target-specific variables are inherited by their
# prerequisites, so `up-systems: up` runs `up` with SYSTEMS=1 in effect.
up-systems: SYSTEMS = 1
up-systems: up

up-docker-provider: DOCKER_PROVIDER = 1
up-docker-provider: up