# code-conductor — Docker Compose deployment

Run the code-conductor orchestrator on any host with Docker, self-contained — no `.devcontainer`, no Termux. One `docker/.env` file drives it; the container bind-mounts this checkout (the running code) and a projects directory (the state) and boots exactly what `npm start` boots.

The **Makefile in this directory is the canonical invocation**. Raw `docker compose` from this directory with an explicit `-f` list is the documented equivalent; never mix raw compose with a `COMPOSE_FILE` env var (a `-f` flag silently overrides it).

## Quick start

```bash
cd <repo>/docker
cp .env.example .env         # set CC_PROJECTS_DIR + auth
mkdir -p "$CC_PROJECTS_DIR"  # OUTSIDE the cc repo, writable by CC_UID/CC_GID
make up                      # = docker compose -f compose.yaml up -d --build
open http://127.0.0.1:8787   # logs: make logs · stop: make down
```

Optional stacks:

```bash
make up-systems              # + /dev/fuse + SYS_ADMIN + apparmor=unconfined (cc's SYSTEMS/fuse-union feature)
make up-docker-provider      # + host docker.sock (pair with CC_WITH_DOCKERIO=1)
make GPU=1 up                # + host GPU via gpus: all (needs nvidia-container-toolkit; pair with CC_WITH_OLLAMA=1)
```

Older setups: `make DOCKER_COMPOSE=docker-compose up` (or an exported `DOCKER_COMPOSE`).

## Variables (see `.env.example` for the full commented list)

| Variable | Default | Meaning |
|---|---|---|
| `CC_PROJECTS_DIR` | *(required)* | Host projects root. Must exist, be outside the cc repo, and be writable by `CC_UID`/`CC_GID`. |
| `CC_PORT` | `8787` | Host port (container side is fixed 8787). |
| `CC_BIND` | `127.0.0.1` | Host IP the port publishes on. Loopback by default on purpose — widen deliberately. |
| `CC_UID` / `CC_GID` | `1000` / `1000` | Container uid/gid; set to the owner of `CC_PROJECTS_DIR`. |
| `CC_HOME_DIR` | `<root>/.cc-home` | Container `$HOME` — credentials, transcripts, `.claude.json`, `.gitconfig`, npm cache. |
| `CC_TZ` | `UTC` | Container timezone. |
| `ANTHROPIC_API_KEY` | *(empty)* | Auth for spawned claude sessions (children inherit the orchestrator env). |
| `CLAUDE_BIN` | *(empty)* | Alternative claude binary inside the container. |
| `CC_WITH_DOCKERIO` / `CC_WITH_CLOUDFLARED` / `CC_WITH_TAILSCALE` / `CC_WITH_OLLAMA` / `CC_WITH_CODEX` | `0` | Build-time tooling flags — see below. |

Make variables (not env vars): `SYSTEMS`, `DOCKER_PROVIDER`, `GPU`, `CC_MOUNT`, `DOCKER_COMPOSE`, `CC_REPO_TARGET`.

## What lives where

| Host path | Container path | What |
|---|---|---|
| `${CC_PROJECTS_DIR}` (required) | `/workspaces/projects` | Projects root: user projects, worktrees, cc's store `.code-conductor/`, `.conduct/`. |
| The tree containing `docker/` | `${CC_REPO_TARGET}` — `/workspaces/code-conductor` (default) or `/workspaces/projects/code-conductor` | The running cc checkout, served in place. |
| *(derived, no extra mount)* `<root>/.cc-home` | `$HOME` | `~/.claude` (credentials, transcripts, settings), `~/.claude.json`, `~/.gitconfig`, npm cache, `.ollama` model data. |
| *(commented in compose.yaml)* host `~/.claude` | `$HOME/.claude` | Optional: reuse the host OAuth sign-in instead of an API key. |
| *(override file)* `/var/run/docker.sock` | `/var/run/docker.sock` | Optional: cc's docker System provider. |

No named volumes in the default path — everything durable sits on the two host bind mounts, so `docker compose down` keeps everything and the state is directly inspectable/backable.

## Auth options

1. **`ANTHROPIC_API_KEY` in `.env`** — simplest. Spawned claude sessions inherit the orchestrator env (`src/instances.ts` passes `process.env` through).
2. **Host `~/.claude` bind** — uncomment the commented volume in `compose.yaml` to reuse an existing host OAuth sign-in.
3. **`CLAUDE_BIN`** — point at a different claude-compatible binary inside the container.

The server boots regardless of auth state (banner warning only); `claude` is needed at session spawn.

## cc mount position (`CC_MOUNT`)

Where this checkout binds inside the container is **behavioral**, because `findSelfProject` (`src/projects.ts`) auto-adopts a checkout as a managed project only when it sits *directly under* the projects root:

- **`CC_MOUNT=outside` (default)** — binds at `/workspaces/projects/../code-conductor`, i.e. `/workspaces/code-conductor`, a *sibling* of the projects root. The checkout is only the runtime code; **it is not a project on the board**, and cc's own development is not driven from that container.
- **`CC_MOUNT=inside`** — binds at `/workspaces/projects/code-conductor`, under the projects root. cc auto-adopts it into workspace `CC-Dev`, so cc's own development can be driven from that container. (The `inside` target shadows that subtree of the projects-root mount — mount specificity wins regardless of order.)

Compose interpolation can't map `outside|inside` to a path, so the Makefile resolves `CC_MOUNT` into `CC_REPO_TARGET` (the concrete container path), exported for both the bind target and the `REPO_DIR` env. **A directly-set `CC_REPO_TARGET` wins** — `make CC_REPO_TARGET=/custom up` bypasses the `CC_MOUNT` resolution.

Raw-compose users set `CC_REPO_TARGET` directly instead: `/workspaces/code-conductor` (outside) or `/workspaces/projects/code-conductor` (inside). A `CC_REPO_TARGET` in `.env` is not read by make — set it on the make command line or in the environment.

## Optional tooling

Baked at build time behind `ARG`s (all default OFF) via the `CC_WITH_*` env vars; **never installed at boot** — to add or remove a flag, set it in `.env` and rebuild (`make up` always builds). To also refresh the base image, run `docker compose -f compose.yaml build --pull`. Approximate upstream image-size costs:

| Flag | Size | Notes |
|---|---|---|
| `CC_WITH_DOCKERIO=1` | ~350 MB | docker.io CLI. Enable the socket mount too: `make up-docker-provider`. |
| `CC_WITH_CLOUDFLARED=1` | ~60 MB | cloudflared, via the cloudflare apt repo. |
| `CC_WITH_TAILSCALE=1` | ~120 MB | tailscale, via `tailscale.com/install.sh`. |
| `CC_WITH_CODEX=1` | ~100–200 MB | `@openai/codex` npm global. |
| `CC_WITH_OLLAMA=1` | ~1–2 GB | ollama; `ollama serve` must be started manually inside the container if wanted. Pulled models persist under `$HOME` (`.cc-home/.ollama`). |

Sizes are upstream estimates, not measured here.

**Why override files, not compose profiles:** profiles attach to whole services/top-level elements; they cannot toggle an individual mount, device, capability, or `security_opt` on the shared `conductor` service. Override files chained through the Makefile's `-f` list are compose's documented mechanism for per-service deltas and keep the base file single-purpose. The runtime deltas ride on three files, all default OFF:

- `compose.docker.yaml` — `/var/run/docker.sock` (pair with `CC_WITH_DOCKERIO=1`).
- `compose.systems.yaml` — `/dev/fuse` + `SYS_ADMIN` + `apparmor=unconfined` (mirrors the devcontainer's runArgs for the fuse-union worktree feature).
- `compose.gpu.yaml` — `gpus: all`. Requires **nvidia-container-toolkit on the host**; ollama auto-detects CUDA devices when present, and falls back to CPU otherwise. Compose ≥ v2.30 (2024-09); the `deploy.resources.reservations.devices` / `driver: nvidia` spelling is in the file's comment for older compose.

Raw-compose equivalent, from this directory: `docker compose -f compose.yaml -f compose.systems.yaml up -d --build`.

## Behavior notes

- The container may create `node_modules/`, `server.log`, `.claude/` in the **host checkout** (deps install into the bind mount — image-baked ones would be shadowed). All gitignored; a worktree's broken `node_modules` symlink is removed (the symlink only) before reinstalling.
- An empty/missing projects dir boots with **zero projects**: unset `CC_PROJECTS_DIR` → compose fails with a `:?` message; set-but-missing → `create_host_path: false` errors instead of docker's root-owned auto-create; the entrypoint pre-flight is the final layer (existence, writability, `.git`-ancestor probe) with remediation text. With `CC_MOUNT=inside`, cc additionally self-adopts the repo into workspace `CC-Dev`.
- `docker compose exec conductor <cmd>` lands in the projects root (`WORKDIR` is `/workspaces/projects`, not the checkout) — convenient for poking at projects. The entrypoint `cd`s into the checkout itself before exec'ing.
- **Don't run cc's self-update from a worktree checkout** — its `.git` is a file, not a directory.
- `HOST=0.0.0.0` is set unconditionally: server.ts defaults to `127.0.0.1`, which would be unreachable from outside the container.

## Persistence

`docker compose down` keeps everything (no named volumes in the default path); `down` + `up -d` restores projects and settings from the store. Deleting `node_modules` in the checkout is fine — the entrypoint repairs deps on boot.

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `FATAL (cc-entrypoint): the cc checkout is not mounted at …` | Repo bind mount missing or `CC_REPO_TARGET`/`CC_MOUNT` misconfigured. |
| `FATAL (cc-entrypoint): … is inside a git repository` | `CC_PROJECTS_DIR` sits inside a git tree (`.git` present at some ancestor — file or directory). Move it outside the repo; cc refuses such store placements. |
| `FATAL (cc-entrypoint): the projects root … is not writable` | uid mismatch — `chown` the dir to `CC_UID:CC_GID` (find them: `stat -c '%u %g' <dir>`). |
| `WARNING (cc-entrypoint): CC_WITH_DOCKERIO=1 but /var/run/docker.sock is not a socket` | The `compose.docker.yaml` override isn't in the `-f` list — use `make up-docker-provider`. |
| Port already in use | Change `CC_PORT` in `.env`. |
| Health banner at boot | Same readiness codes as native boots (`src/health.ts`) — missing `claude` CLI or credentials. The server starts anyway. |
| GPU absent for ollama | Install nvidia-container-toolkit on the host, or run ollama CPU-only. |
| Compose too old for `gpus: all` | Use the `deploy.resources.reservations.devices` spelling in `compose.gpu.yaml`'s comment. |
| `create_host_path: false` unsupported | Compose ≥ 2.x required; `mkdir -p` the projects dir yourself — the entrypoint pre-flight covers either way. |