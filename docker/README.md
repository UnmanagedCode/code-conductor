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
make GPU=1 up                # + host GPU via gpus: all (needs nvidia-container-toolkit; pair with CC_WITH_OLLAMA=1)
```

Two `.env` flags each drive a build **and** a compose-chain half from one knob; set them and run plain `make up`:

- `CC_WITH_SYSTEMS=1` — bakes the packages cc's Systems feature needs and chains `compose.systems.yaml` (`/dev/fuse` + `SYS_ADMIN` + `apparmor=unconfined`). See "cc's Systems feature in the container".
- `CC_WITH_DOCKER=1` — installs the docker client and chains the docker.sock mount (`compose.docker.yaml`). Pair it with `CC_DOCKER_GID` — see "Docker from inside the container".

Older setups: `make DOCKER_COMPOSE=docker-compose up` (or an exported `DOCKER_COMPOSE`).

## Variables (see `.env.example` for the full commented list)

| Variable | Default | Meaning |
|---|---|---|
| `CC_PROJECTS_DIR` | *(required)* | Absolute host projects root. Must exist, be outside the cc repo, and be writable by `CC_UID`/`CC_GID`. |
| `CC_PORT` | `8787` | Host port (container side is fixed 8787). |
| `CC_BIND` | `127.0.0.1` | Host IP the port publishes on. Loopback by default on purpose — widen deliberately. |
| `CC_USER` | `node` | The **account** the container runs as (compose `user:`). The name form, not `uid:gid` — docker resolves a name through the image's passwd/group files and loads the account's supplementary groups; a bare uid with no account in the image drops them all and makes `sudo` fail with *you do not exist in the passwd database*. |
| `CC_UID` / `CC_GID` | `1000` / `1000` | The ids `CC_USER` carries; set to the owner of `CC_PROJECTS_DIR`. The build reconciles the account onto them and **fails, naming the squatter**, if another account or group in the base image already holds one. |
| `CC_HOME_DIR` | `<root>/.cc-home` | Container `$HOME` — credentials, transcripts, `.claude.json`, `.gitconfig`, npm cache. |
| `CC_TZ` | `UTC` | Container timezone. |
| `CC_BASE_IMAGE` | `node:24-trixie` | Docker base image (passed to the build as `BASE_IMAGE`). Must provide Node ≥ 24 (cc's engines requirement); the claude CLI installs via npm on whatever base is chosen. An older base is fine **except** with `CC_WITH_CLAUDE_CODE_PROXY=1` — the proxy's prebuilt binary is dynamically linked and needs GLIBC ≥ 2.39 (`node:24-bookworm` ships 2.36, trixie 2.41). Second suite caveat: `docker-cli` exists from trixie onward only, so on bookworm/bullseye `CC_WITH_DOCKER=1` falls back to `docker.io` and costs ~255 MB instead of ~30 MB. |
| `CC_BASE_IMAGE_FILE` | *(empty)* | A Dockerfile the Makefile pre-builds into `code-conductor-base:local` and feeds to the service build as its base. Build context is the **directory containing** the file (that directory's own `.dockerignore` applies, not `docker/.dockerignore`); a relative path resolves against `docker/`. Setting it together with `CC_BASE_IMAGE` fails `make build`/`make up`. **Makefile only.** |
| `CC_DOCKER_GID` | `${CC_GID}` | Gid of the **host** docker socket, added to `CC_USER`'s groups when `CC_WITH_DOCKER=1`. See "Docker from inside the container". |
| `CC_COMPOSE_EXTRA` | *(empty)* | Extra compose file(s) chained **last**, so they override the built-in chain. Space-separated and **unquoted** (make keeps quote characters literally); paths relative to `docker/`. **Makefile only.** |
| `CLAUDE_BIN` | *(empty)* | Alternative claude binary inside the container. Empty (and whitespace-only) means the stock `claude` on `$PATH`. |
| `CC_WITH_DOCKER` / `CC_WITH_SYSTEMS` / `CC_WITH_CLOUDFLARED` / `CC_WITH_TAILSCALE` / `CC_WITH_OLLAMA` / `CC_WITH_CLAUDE_CODE_PROXY` | `0` | Build-time tooling flags — see below. `CC_WITH_DOCKER` and `CC_WITH_SYSTEMS` are **also** compose-chain triggers (they pull in `compose.docker.yaml` / `compose.systems.yaml`). `CC_WITH_OLLAMA`, `CC_WITH_CLAUDE_CODE_PROXY`, and `CC_WITH_TAILSCALE` also start their service detached at boot. |

Make variables: `GPU`, `CC_MOUNT`, `DOCKER`, `DOCKER_COMPOSE`, `CC_REPO_TARGET` — `CC_MOUNT` and `CC_REPO_TARGET` may also be set in `.env` (the Makefile `-include`s it; the make command line still wins over `.env`). `DOCKER` (default `docker`) is used only for the `CC_BASE_IMAGE_FILE` pre-build, which compose cannot do.

## What lives where

| Host path | Container path | What |
|---|---|---|
| `${CC_PROJECTS_DIR}` (required) | `/workspaces/projects` | Projects root: user projects, worktrees, cc's store `.code-conductor/`, `.conduct/`. |
| The tree containing `docker/` | `${CC_REPO_TARGET}` — `/workspaces/code-conductor` (default) or `/workspaces/projects/code-conductor` | The running cc checkout, served in place. |
| *(derived, no extra mount)* `<root>/.cc-home` | `$HOME` | `~/.claude` (credentials, transcripts, settings), `~/.claude.json`, `~/.gitconfig`, npm cache, `.ollama` model data, `.tailscale` (tailscaled state / node key). |
| *(override file, chained by `CC_WITH_DOCKER=1`)* `/var/run/docker.sock` | `/var/run/docker.sock` | Optional: docker usable from inside the container. Containers you run from inside then get `HOST_PROJECTS_DIR` = the host path you set in `CC_PROJECTS_DIR` — use it as the `-v` source for their mounts (bind sources resolve on the HOST, not in this container). |
| *(manual, post-boot)* any host dir | `/workspaces/<basename>` | One-off extra bind via `make PROJECT=… mount` (`docker/cc-mount.py`) — see "Mounting an extra host directory" below. Not visible to `docker inspect .Mounts`; gone on container restart. |

No named volumes in the default path — everything durable sits on the two host bind mounts, so `docker compose down` keeps everything and the state is directly inspectable/backable.

## Auth

**Sign in inside the container — the only auth path.** After `make up`, run `make login` (= `docker compose -f compose.yaml exec conductor claude auth login`): it starts the claude sign-in flow directly in the container — open the URL it prints in your host's browser, complete the sign-in, then exit. Other services sign in the same way, inside the container. Credentials land under `<CC_PROJECTS_DIR>/.cc-home/.claude` on the host projects-root bind, so they persist across container recreation (`down` + `up -d`); spawned claude sessions inherit the orchestrator's `$HOME`, so they see them.

Escape hatch: **`CLAUDE_BIN`** — point at a different claude-compatible binary inside the container. `make login` signs in the stock `claude`; a `CLAUDE_BIN` binary manages its own auth.

The server boots regardless of auth state (banner warning only); `claude` is needed at session spawn.

**claude-code-proxy (with `CC_WITH_CLAUDE_CODE_PROXY=1`).** The flag installs the `claude-code-proxy` binary (an Anthropic-compatible API backed by a ChatGPT sign-in) and the entrypoint starts `claude-code-proxy serve` detached at boot; it restarts with the container (log: `<projects dir>/.cc-home/logs/claude-code-proxy-serve.log`, default HOME). Its **authentication** stays in-container and the `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` **routing** is configured in **cc's backends feature** — see `docs/models.md` → Backends and Settings → Backends for the template/env rules:

1. **Sign in** — ChatGPT Plus or Pro account, not an OpenAI API account:
   ```bash
   docker compose -f compose.yaml exec conductor claude-code-proxy codex auth login
   ```
   Credentials persist under `$HOME` (`.cc-home` on the host bind) like the claude sign-in.
2. **The proxy is already serving** — started by the container at boot when the flag is on, detached, and it restarts with the container; no manual serve step. It binds `127.0.0.1:18765` (verified default).
3. **Route sessions through it** — in the orchestrator's **Settings → Backends**, add a user backend row whose env pairs carry `ANTHROPIC_BASE_URL=http://127.0.0.1:18765` and `ANTHROPIC_AUTH_TOKEN=unused` (upstream model-routing envs — `ANTHROPIC_MODEL` etc., documented at claude-code-proxy.raine.dev — ride the same pairs).

**tailscale (with `CC_WITH_TAILSCALE=1`).** The entrypoint starts `tailscaled --tun userspace-networking` detached at boot (it restarts with the container; log: `<projects dir>/.cc-home/logs/tailscaled.log`, default HOME). Starting the daemon does **not** join the tailnet — authenticate once, then approve the node in the browser:

```bash
make login/tailscale
```

(= `docker compose -f compose.yaml exec conductor tailscale up`.) State lives under `$HOME` (`<projects dir>/.cc-home/.tailscale/`), so the node key persists across container recreation: after the first join, later boots come up connected automatically.

## cc mount position (`CC_MOUNT`)

Where this checkout binds inside the container:

- **`CC_MOUNT=outside` (default)** — binds at `/workspaces/projects/../code-conductor`, i.e. `/workspaces/code-conductor`, a *sibling* of the projects root. The checkout is only the runtime code; **it is not a project on the board**, and cc's own development is not driven from that container.
- **`CC_MOUNT=inside`** — binds at `/workspaces/projects/code-conductor`, under the projects root. cc auto-adopts it into workspace `CC-Dev`, so cc's own development can be driven from that container. (The `inside` target shadows that subtree of the projects-root mount — mount specificity wins regardless of order.)

The Makefile resolves `CC_MOUNT` into `CC_REPO_TARGET` (the concrete container path), exported for both the bind target and the `REPO_DIR` env. **A directly-set `CC_REPO_TARGET` wins** — `make CC_REPO_TARGET=/custom up` bypasses the `CC_MOUNT` resolution.

Raw-compose users set `CC_REPO_TARGET` directly instead: `/workspaces/code-conductor` (outside) or `/workspaces/projects/code-conductor` (inside). A `CC_REPO_TARGET` in `.env` is read by make too (it `-include`s `.env`) and wins over the `CC_MOUNT` resolution; the make command line still wins over `.env`.

## Mounting an extra host directory into the running container

Bind-mount one host directory into the **running** conductor container — no container restart, no compose edit:

```bash
make PROJECT=/x/y/project mount    # from this directory; flags via ARGS= (e.g. ARGS=-r)
sudo python3 cc-mount.py [-r] [--container NAME | --pid PID] [--check] HOST-DIR
docker compose -f compose.yaml exec conductor ls /workspaces/<basename>   # verify
```

`HOST-DIR` lands at `/workspaces/<basename>` (name derived from the given path, not its realpath); the container is found automatically via the `com.docker.compose.service=conductor` label, `--container`/`--pid` override that (`--pid` skips docker). Requires host root (CAP_SYS_ADMIN), Linux ≥ 5.2, Python 3; unprivileged `--check` diagnoses platform/kernel/docker/target without mounting. Non-zero exits: 2 bad usage · 3 container not found/running · 4 kernel < 5.2 or missing privilege · 5 target exists/missing.

Notes:

- Invisible to `docker inspect .Mounts` and **gone on container restart** — re-run the command to restore; for a permanent bind, add it to compose instead.
- Removal (the container has no SYS_ADMIN): host-side `sudo nsenter -t $(docker inspect --format '{{.State.Pid}}' <container>) -m umount /workspaces/<name>` — the empty mountpoint dir persists in the overlay afterwards.
- The mounted dir is a sibling of the projects root → cc does not auto-adopt it: MCP `adopt_project({name, path: "/workspaces/<name>"})` or `POST /api/projects/external`.

## Optional tooling

Baked at build time behind `ARG`s (all default OFF) via the `CC_WITH_*` env vars; **never installed at boot** — to add or remove a flag, set it in `.env` and rebuild (`make up` always builds). To also refresh the base image, run `docker compose -f compose.yaml build --pull` — **except** with `CC_BASE_IMAGE_FILE` set, where the base is a local tag and `--pull` fails; refresh that base by rebuilding its own Dockerfile instead (`make build` does it).

Installed **unconditionally**, not behind a flag: `sudo` (~10 MB) plus `/etc/sudoers.d/cc-conductor`, a passwordless `SETENV` rule for `CC_USER` — cc's Systems feature probes for exactly that pair (`src/systems/fuse/preflight.ts`), and the build runs `visudo -c` so a malformed rule fails the build rather than the first spawn.

| Flag | Size | Notes |
|---|---|---|
| `CC_WITH_DOCKER=1` | ~30 MB trixie+ · ~255 MB older | The docker **client** (`docker-cli` from trixie onward; `docker.io`, which carries the daemon too, on bookworm/bullseye where `docker-cli` does not exist) **and** the `/var/run/docker.sock` mount (the Makefile chains `compose.docker.yaml` from the same flag — one knob; raw compose must add `-f compose.docker.yaml` itself). Also exports `HOST_PROJECTS_DIR` into the container — see What lives where. |
| `CC_WITH_SYSTEMS=1` | ~8 MB on `node:24-trixie` | The packages cc's Systems feature needs **and** the `compose.systems.yaml` runtime deltas, from one flag. ~250 MB on a base carrying no compiler toolchain. See "cc's Systems feature in the container". |
| `CC_WITH_CLOUDFLARED=1` | ~60 MB | cloudflared, via the cloudflare apt repo. |
| `CC_WITH_TAILSCALE=1` | ~120 MB | tailscale, via `tailscale.com/install.sh`. The entrypoint starts `tailscaled --tun userspace-networking` detached at boot (log: `<projects dir>/.cc-home/logs/tailscaled.log`, default HOME); joining the tailnet needs a one-time `make login/tailscale` — see Auth. |
| `CC_WITH_CLAUDE_CODE_PROXY=1` | ~30 MB | `claude-code-proxy`; the entrypoint starts `claude-code-proxy serve` detached at boot (claude runs through the proxy; wired via cc's backends — see Auth below). |
| `CC_WITH_OLLAMA=1` | ~1–2 GB | ollama; the entrypoint starts `ollama serve` detached at boot (log: `<projects dir>/.cc-home/logs/ollama-serve.log`, default HOME). Pulled models persist under `$HOME` (`.cc-home/.ollama`). |

The Debian-package sizes are computed from trixie apt metadata — `Installed-Size` summed over the `Depends` closure, minus what `node:24-trixie` already carries. The upstream-installer sizes (cloudflared, tailscale, ollama, claude-code-proxy) are upstream estimates. Both are estimates, not measured image deltas.

The runtime deltas ride on four files, all default OFF:

- `compose.docker.yaml` — `/var/run/docker.sock` + `group_add: [${CC_DOCKER_GID}]`. Chained automatically by the Makefile when `CC_WITH_DOCKER=1`; raw compose adds `-f compose.docker.yaml` itself.
- `compose.systems.yaml` — `/dev/fuse` + `SYS_ADMIN` + `apparmor=unconfined` (the runtime deltas cc's Systems feature needs to run — ⚙ Settings → Systems / placing a project on another machine). Chained automatically by the Makefile when `CC_WITH_SYSTEMS=1`; raw compose adds `-f compose.systems.yaml` itself.
- `compose.gpu.yaml` — `gpus: all`. Requires **nvidia-container-toolkit on the host**; ollama auto-detects CUDA devices when present, and falls back to CPU otherwise. Compose ≥ v2.30 (2024-09); the `deploy.resources.reservations.devices` / `driver: nvidia` spelling is in the file's comment for older compose.
- `CC_COMPOSE_EXTRA` — the operator-supplied tail of the chain, appended after all of the above so it wins. **Makefile only**; raw compose passes its own `-f` list.

Raw-compose equivalent, from this directory: `docker compose -f compose.yaml -f compose.systems.yaml up -d --build` — and with `CC_WITH_DOCKER=1`, add `-f compose.docker.yaml`. The `-f` supplies only the **runtime** half; `CC_WITH_SYSTEMS=1` / `CC_WITH_DOCKER=1` must still be set for the **build** half, or the image comes up with none of the corresponding packages in it.

## Docker from inside the container

`CC_WITH_DOCKER=1` installs the docker **client only** — no daemon runs in this container; it talks to the host's through the bind-mounted `/var/run/docker.sock`.

The socket is group-owned and mode `0660` on the host, so `CC_USER` must carry that group. The gid is a host property, unknowable at build time — read it on the **host** and put it in `.env`:

```bash
stat -c '%g' /var/run/docker.sock    # → e.g. 984
# docker/.env:  CC_DOCKER_GID=984
```

`compose.docker.yaml` feeds it to `group_add`. Its default is a no-op (`CC_USER` already carries `CC_GID`); with the wrong value, every docker call inside the container fails with *permission denied while trying to connect to the Docker daemon socket*, and the entrypoint says so at boot.

`sudo docker …` also reaches the socket (the image's sudo rule is passwordless) — a one-off escape hatch when the gid is wrong, **not** the intended path: cc's spawned sessions invoke `docker` as ordinary tool calls, and nothing rewrites those to `sudo`.

Socket access is root-equivalent on the host either way; `CC_WITH_DOCKER=1` is the deliberate choice to grant it.

## cc's Systems feature in the container

`CC_WITH_SYSTEMS=1` makes ⚙ Settings → Systems usable from inside the container: it bakes the packages and chains `compose.systems.yaml`. `src/systems/fuse/preflight.ts` is the authority — it refuses a spawn with `FUSE_UNAVAILABLE: …` naming the first probe that failed, so a refusal maps straight onto a row here:

| Probe | Supplied by |
|---|---|
| `/dev/fuse` is a character device | `compose.systems.yaml`'s `devices:` — **runtime, no package** |
| `sudo -n true` | `sudo` + `/etc/sudoers.d/cc-conductor` + an account for the uid (all unconditional) |
| `sudo -n -E` preserves the environment | the `SETENV:` tag on that rule |
| `unshare`, `nsenter`, `setpriv` | `util-linux` |
| `mount`, `umount` | `mount` (Debian splits these out of `util-linux`) |
| `chroot` | `coreutils` |
| `fusermount3` | `fuse3` |
| `fusectl` in `/proc/filesystems` | **the host kernel** — not installable |
| `gcc` | `gcc` (+ `libc6-dev`, for the union daemon's compile) |
| `pkg-config --exists fuse3` | `pkg-config` + `libfuse3-dev` |

Also needed but not probed: `awk`, `sed`, `tr`, `head`, `printf`, `readlink` — the namespace scan shells out to them, and a missing one yields an empty scan rather than an error.

**Two of those the image cannot provide.** `/dev/fuse` needs the device passthrough (the same flag chains it — the entrypoint warns at boot if the `-f` is missing), and `fusectl` is a property of the **host kernel**. A green build can therefore still refuse at spawn time on a host whose kernel lacks fusectl support.

## Behavior notes

- The container's dep repair may create `node_modules/` in the **host checkout**. It is gitignored; a worktree's broken `node_modules` symlink is removed (the symlink only) before reinstalling.
- An empty/missing projects dir boots with **zero projects**: unset `CC_PROJECTS_DIR` → compose fails with a `:?` message; set-but-missing → `create_host_path: false` errors; the entrypoint pre-flight is the final layer (existence, writability, `.git`-ancestor probe) with remediation text. With `CC_MOUNT=inside`, cc additionally self-adopts the repo into workspace `CC-Dev`.
- `docker compose exec conductor <cmd>` lands in the projects root (`WORKDIR` is `/workspaces/projects`, not the checkout) — convenient for poking at projects. The entrypoint `cd`s into the checkout itself before exec'ing.
- **Don't run cc's self-update from a worktree checkout** — its `.git` is a file, not a directory.
- `HOST=0.0.0.0` is set unconditionally.

## Persistence

`docker compose down` keeps everything (no named volumes in the default path); `down` + `up -d` restores projects and settings from the store. Deleting `node_modules` in the checkout is fine — the entrypoint repairs deps on boot.

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `FATAL (cc-entrypoint): the cc checkout is not mounted at …` | Repo bind mount missing or `CC_REPO_TARGET`/`CC_MOUNT` misconfigured. |
| `FATAL (cc-entrypoint): … is inside a git repository` | `CC_PROJECTS_DIR` sits inside a git tree (`.git` present at some ancestor — file or directory). Move it outside the repo; cc refuses such store placements. |
| `FATAL (cc-entrypoint): the projects root … is not writable` | uid mismatch — `chown` the dir to `CC_UID:CC_GID` (find them: `stat -c '%u %g' <dir>`). |
| `WARNING (cc-entrypoint): CC_WITH_DOCKER=1 but /var/run/docker.sock is not a socket` | The `compose.docker.yaml` override isn't in the `-f` list — the Makefile chains it automatically from `CC_WITH_DOCKER=1`; raw compose must add `-f compose.docker.yaml` itself. |
| `WARNING (cc-entrypoint): … docker.sock is mounted but not writable` | `CC_DOCKER_GID` is unset or wrong — set it to `stat -c '%g' /var/run/docker.sock` on the host and re-up. |
| `WARNING (cc-entrypoint): CC_WITH_SYSTEMS=1 but /dev/fuse is not a character device` | The `compose.systems.yaml` override isn't in the `-f` list — the Makefile chains it automatically from `CC_WITH_SYSTEMS=1`; raw compose must add `-f compose.systems.yaml` itself. |
| `FUSE_UNAVAILABLE: … fusectl …` | The **host kernel** does not expose fusectl; no package fixes it. Run that System on a different host. |
| `FUSE_UNAVAILABLE: …` naming any other binary or header | `CC_WITH_SYSTEMS=1` was not set for the **build** — an `-f compose.systems.yaml` alone gives the runtime deltas and an image with no FUSE packages. |
| `FATAL (setup-user): cannot … uid/gid … already holds it` | `CC_UID`/`CC_GID` collide with an account or group already in the base image (the message names it). Pick different ids, or a base image where they are free. |
| `*** CC_BASE_IMAGE and CC_BASE_IMAGE_FILE are both set` | Two base-image knobs; unset one in `docker/.env`. |
| Port already in use | Change `CC_PORT` in `.env`. |
| Health banner at boot | Same readiness codes as native boots (`src/health.ts`) — missing `claude` CLI or credentials. The server starts anyway. |
| GPU absent for ollama | Install nvidia-container-toolkit on the host, or run ollama CPU-only. |
| Compose too old for `gpus: all` | Use the `deploy.resources.reservations.devices` spelling in `compose.gpu.yaml`'s comment. |
| `create_host_path: false` unsupported | Compose ≥ 2.x required; `mkdir -p` the projects dir yourself — the entrypoint pre-flight covers either way. |
| `cc-mount` exit 4 (`EPERM`) | Run it on the host with sudo — CAP_SYS_ADMIN is needed in the user namespace owning the container's mount namespace. |
| `cc-mount` exit 3 (no container) | No running container carries the `com.docker.compose.service=conductor` label — `make up` first, or pass `--container`/`--pid`. |