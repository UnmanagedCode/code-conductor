# code-conductor — Docker Compose deployment

Run the code-conductor orchestrator on any host with Docker, self-contained — one `docker/.env` plus the Makefile drive it. The container bind-mounts this checkout (the running code) and a projects directory (the state) and boots exactly what `npm start` boots.

The **Makefile in this directory is the canonical invocation**. Raw `docker compose` from this directory with an explicit `-f` list is the documented equivalent; never mix raw compose with a `COMPOSE_FILE` env var (a `-f` flag silently overrides it).

## Quick start

```bash
cd <repo>/docker
cp .env.example .env         # set CC_PROJECTS_DIR
set -a; . ./.env; set +a     # put CC_PROJECTS_DIR in the shell (compose reads .env itself)
mkdir -p "$CC_PROJECTS_DIR"  # OUTSIDE the cc repo, writable by CC_UID/CC_GID
make up                      # = docker compose -f compose.yaml up -d --build
make login                   # sign in inside the container: `claude auth login` (credentials persist)
open http://127.0.0.1:8787   # logs: make logs · stop: make down
```

Optional stacks:

```bash
make up-systems              # + /dev/fuse + SYS_ADMIN + apparmor=unconfined (cc's Systems feature)
make GPU=1 up                # + host GPU via gpus: all (needs nvidia-container-toolkit; pair with CC_WITH_OLLAMA=1)
```

With `CC_WITH_DOCKER=1` in `.env`, plain `make up` also chains the docker.sock mount (`compose.docker.yaml`) — one flag turns on the docker.io CLI build and the socket together.

Older setups: `make DOCKER_COMPOSE=docker-compose up` (or an exported `DOCKER_COMPOSE`).

## Variables (see `.env.example` for the full commented list)

| Variable | Default | Meaning |
|---|---|---|
| `CC_PROJECTS_DIR` | *(required)* | Absolute host projects root. Must exist, be outside the cc repo, and be writable by `CC_UID`/`CC_GID`. |
| `CC_PORT` | `8787` | Host port (container side is fixed 8787). |
| `CC_BIND` | `127.0.0.1` | Host IP the port publishes on. Loopback by default on purpose — widen deliberately. |
| `CC_UID` / `CC_GID` | `1000` / `1000` | Container uid/gid; set to the owner of `CC_PROJECTS_DIR`. |
| `CC_HOME_DIR` | `<root>/.cc-home` | Container `$HOME` — credentials, transcripts, `.claude.json`, `.gitconfig`, npm cache. |
| `CC_TZ` | `UTC` | Container timezone. |
| `CLAUDE_BIN` | *(empty)* | Alternative claude binary inside the container. |
| `CC_WITH_DOCKER` / `CC_WITH_CLOUDFLARED` / `CC_WITH_TAILSCALE` / `CC_WITH_OLLAMA` / `CC_WITH_CLAUDE_CODE_PROXY` | `0` | Build-time tooling flags — see below. `CC_WITH_OLLAMA` and `CC_WITH_CLAUDE_CODE_PROXY` also start their service detached at boot. |

Make variables: `SYSTEMS`, `GPU`, `CC_MOUNT`, `DOCKER_COMPOSE`, `CC_REPO_TARGET` — `CC_MOUNT` and `CC_REPO_TARGET` may also be set in `.env` (the Makefile `-include`s it; the make command line still wins over `.env`).

## What lives where

| Host path | Container path | What |
|---|---|---|
| `${CC_PROJECTS_DIR}` (required) | `/workspaces/projects` | Projects root: user projects, worktrees, cc's store `.code-conductor/`, `.conduct/`. |
| The tree containing `docker/` | `${CC_REPO_TARGET}` — `/workspaces/code-conductor` (default) or `/workspaces/projects/code-conductor` | The running cc checkout, served in place. |
| *(derived, no extra mount)* `<root>/.cc-home` | `$HOME` | `~/.claude` (credentials, transcripts, settings), `~/.claude.json`, `~/.gitconfig`, npm cache, `.ollama` model data. |
| *(override file, chained by `CC_WITH_DOCKER=1`)* `/var/run/docker.sock` | `/var/run/docker.sock` | Optional: docker usable from inside the container. Containers you run from inside then get `HOST_PROJECTS_DIR` = the host path you set in `CC_PROJECTS_DIR` — use it as the `-v` source for their mounts (bind sources resolve on the HOST, not in this container). |

No named volumes in the default path — everything durable sits on the two host bind mounts, so `docker compose down` keeps everything and the state is directly inspectable/backable.

## Auth

**Sign in inside the container — the only auth path.** After `make up`, run `make login` (= `docker compose -f compose.yaml exec conductor claude auth login`): it starts the claude sign-in flow directly in the container — open the URL it prints in your host's browser, complete the sign-in, then exit. Other services sign in the same way, inside the container. Credentials land under `<CC_PROJECTS_DIR>/.cc-home/.claude` on the host projects-root bind, so they persist across container recreation (`down` + `up -d`); spawned claude sessions inherit the orchestrator's `$HOME` (`src/instances.ts` passes `process.env` through), so they see them.

Escape hatch: **`CLAUDE_BIN`** — point at a different claude-compatible binary inside the container. `make login` signs in the stock `claude`; a `CLAUDE_BIN` binary manages its own auth.

The server boots regardless of auth state (banner warning only); `claude` is needed at session spawn.

**claude-code-proxy (with `CC_WITH_CLAUDE_CODE_PROXY=1`).** The flag installs the `claude-code-proxy` binary — a local server that exposes an **Anthropic-compatible API backed by a ChatGPT sign-in**, which claude sessions run through (the proxy translates claude's API traffic to the provider) — and the entrypoint starts `claude-code-proxy serve` detached at boot; it restarts with the container (log: `<projects dir>/.cc-home/logs/claude-code-proxy-serve.log`, default HOME). The deployment launches the process; its **authentication** stays in-container and the `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` **routing** is configured in **cc's backends feature** inside the orchestrator — see `docs/models.md` → Backends and Settings → Backends for the template/env rules:

1. **Sign in** — ChatGPT Plus or Pro account, not an OpenAI API account:
   ```bash
   docker compose -f compose.yaml exec conductor claude-code-proxy codex auth login
   ```
   Credentials persist under `$HOME` (`.cc-home` on the host bind) like the claude sign-in. (`codex auth login` is the proxy's own subcommand name — it manages the codex/ChatGPT side.)
2. **The proxy is already serving** — started by the container at boot when the flag is on, detached, and it restarts with the container; no manual serve step. It binds `127.0.0.1:18765` (verified default).
3. **Route sessions through it** — in the orchestrator's **Settings → Backends**, add a user backend row whose env pairs carry `ANTHROPIC_BASE_URL=http://127.0.0.1:18765` and `ANTHROPIC_AUTH_TOKEN=unused` (upstream model-routing envs — `ANTHROPIC_MODEL` etc., documented at claude-code-proxy.raine.dev — ride the same pairs).

## cc mount position (`CC_MOUNT`)

Where this checkout binds inside the container is **behavioral**, because `findSelfProject` (`src/projects.ts`) auto-adopts a checkout as a managed project only when it sits *directly under* the projects root:

- **`CC_MOUNT=outside` (default)** — binds at `/workspaces/projects/../code-conductor`, i.e. `/workspaces/code-conductor`, a *sibling* of the projects root. The checkout is only the runtime code; **it is not a project on the board**, and cc's own development is not driven from that container.
- **`CC_MOUNT=inside`** — binds at `/workspaces/projects/code-conductor`, under the projects root. cc auto-adopts it into workspace `CC-Dev`, so cc's own development can be driven from that container. (The `inside` target shadows that subtree of the projects-root mount — mount specificity wins regardless of order.)

Compose interpolation can't map `outside|inside` to a path, so the Makefile resolves `CC_MOUNT` into `CC_REPO_TARGET` (the concrete container path), exported for both the bind target and the `REPO_DIR` env. **A directly-set `CC_REPO_TARGET` wins** — `make CC_REPO_TARGET=/custom up` bypasses the `CC_MOUNT` resolution.

Raw-compose users set `CC_REPO_TARGET` directly instead: `/workspaces/code-conductor` (outside) or `/workspaces/projects/code-conductor` (inside). A `CC_REPO_TARGET` in `.env` is read by make too (it `-include`s `.env`) and wins over the `CC_MOUNT` resolution; the make command line still wins over `.env`.

## Optional tooling

Baked at build time behind `ARG`s (all default OFF) via the `CC_WITH_*` env vars; **never installed at boot** — to add or remove a flag, set it in `.env` and rebuild (`make up` always builds). To also refresh the base image, run `docker compose -f compose.yaml build --pull`. Approximate upstream image-size costs:

| Flag | Size | Notes |
|---|---|---|
| `CC_WITH_DOCKER=1` | ~350 MB | docker.io CLI **and** the `/var/run/docker.sock` mount (the Makefile chains `compose.docker.yaml` from the same flag — one knob; raw compose must add `-f compose.docker.yaml` itself). Also exports `HOST_PROJECTS_DIR` into the container — see What lives where. |
| `CC_WITH_CLOUDFLARED=1` | ~60 MB | cloudflared, via the cloudflare apt repo. |
| `CC_WITH_TAILSCALE=1` | ~120 MB | tailscale, via `tailscale.com/install.sh`. |
| `CC_WITH_CLAUDE_CODE_PROXY=1` | ~30 MB | `claude-code-proxy`; the entrypoint starts `claude-code-proxy serve` detached at boot (claude runs through the proxy; wired via cc's backends — see Auth below). |
| `CC_WITH_OLLAMA=1` | ~1–2 GB | ollama; the entrypoint starts `ollama serve` detached at boot (log: `<projects dir>/.cc-home/logs/ollama-serve.log`, default HOME). Pulled models persist under `$HOME` (`.cc-home/.ollama`). |

Sizes are upstream estimates, not measured here.

**Why override files, not compose profiles:** profiles attach to whole services/top-level elements; they cannot toggle an individual mount, device, capability, or `security_opt` on the shared `conductor` service. Override files chained through the Makefile's `-f` list are compose's documented mechanism for per-service deltas and keep the base file single-purpose. The runtime deltas ride on three files, all default OFF:

- `compose.docker.yaml` — `/var/run/docker.sock`. Chained automatically by the Makefile when `CC_WITH_DOCKER=1` (the same flag bakes the CLI — a docker CLI with no socket is inert, so they travel together); raw compose adds `-f compose.docker.yaml` itself.
- `compose.systems.yaml` — `/dev/fuse` + `SYS_ADMIN` + `apparmor=unconfined` (the runtime deltas cc's Systems feature needs to run — ⚙ Settings → Systems / placing a project on another machine).
- `compose.gpu.yaml` — `gpus: all`. Requires **nvidia-container-toolkit on the host**; ollama auto-detects CUDA devices when present, and falls back to CPU otherwise. Compose ≥ v2.30 (2024-09); the `deploy.resources.reservations.devices` / `driver: nvidia` spelling is in the file's comment for older compose.

Raw-compose equivalent, from this directory: `docker compose -f compose.yaml -f compose.systems.yaml up -d --build` — and with `CC_WITH_DOCKER=1`, add `-f compose.docker.yaml`.

## Behavior notes

- The container's dep repair may create `node_modules/` in the **host checkout** (deps install into the bind mount — image-baked ones would be shadowed). It is gitignored; a worktree's broken `node_modules` symlink is removed (the symlink only) before reinstalling.
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
| `WARNING (cc-entrypoint): CC_WITH_DOCKER=1 but /var/run/docker.sock is not a socket` | The `compose.docker.yaml` override isn't in the `-f` list — the Makefile chains it automatically from `CC_WITH_DOCKER=1`; raw compose must add `-f compose.docker.yaml` itself. |
| Port already in use | Change `CC_PORT` in `.env`. |
| Health banner at boot | Same readiness codes as native boots (`src/health.ts`) — missing `claude` CLI or credentials. The server starts anyway. |
| GPU absent for ollama | Install nvidia-container-toolkit on the host, or run ollama CPU-only. |
| Compose too old for `gpus: all` | Use the `deploy.resources.reservations.devices` spelling in `compose.gpu.yaml`'s comment. |
| `create_host_path: false` unsupported | Compose ≥ 2.x required; `mkdir -p` the projects dir yourself — the entrypoint pre-flight covers either way. |