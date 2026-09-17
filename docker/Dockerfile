# code-conductor image. Build context is this docker/ directory only — the
# repo itself is bind-mounted at runtime, so nothing from the repo is baked
# into the image.
# Default base is Debian trixie: the claude-code-proxy prebuilt binary
# (installed with CC_WITH_CLAUDE_CODE_PROXY=1) is dynamically linked and
# requires GLIBC 2.39; trixie ships 2.41, bookworm only 2.36. Override via
# the BASE_IMAGE build arg (CC_BASE_IMAGE in .env) — an older base is fine
# EXCEPT that proxy build fails there; the base must provide Node >= 24
# (cc's engines requirement). Second suite caveat: the docker-cli package
# exists from trixie onward only, so on a pre-trixie base CC_WITH_DOCKER=1
# takes the docker.io fallback arm below: ~109 MB on node:24-bookworm
# against ~11 MB for docker-cli on node:24-trixie.
ARG BASE_IMAGE=node:24-trixie
FROM ${BASE_IMAGE}

# The claude CLI is needed at session-spawn time; install it into the image so
# containers don't have to.
RUN npm install -g @anthropic-ai/claude-code

# ── The account the container runs as (compose's `user:`) ────────────────
ARG USER_NAME=node
ARG USER_UID=1000
ARG USER_GID=1000
# Declared here, not with the other WITH_* flags below, because setup-user.sh
# writes the sudoers rule and must run after the package is in place. Defaults
# ON: cc's Systems feature needs `sudo -n` (src/systems/fuse/preflight.ts).
ARG WITH_SUDO=1
RUN if [ "$WITH_SUDO" = "1" ]; then apt-get update \
      && apt-get install -y --no-install-recommends sudo \
      && rm -rf /var/lib/apt/lists/*; fi
# The account reconcile runs either way; only the sudoers rule is gated.
COPY setup-user.sh /tmp/setup-user.sh
RUN sh /tmp/setup-user.sh && rm /tmp/setup-user.sh

# WORKDIR is the PROJECTS ROOT, not the cc checkout, so `docker exec` /
# `docker compose exec` land in the projects dir by default. The entrypoint
# cds into the checkout (REPO_DIR) itself right before exec'ing.
WORKDIR /workspaces/projects

# ── Optional tooling, baked at build time only (all default OFF) ─────────
# Each install uses its upstream project's own install method. Nothing is
# ever downloaded
# at container startup; change the flags and rebuild (--build --pull).

ARG WITH_DOCKER=0
# docker-cli (client only, no daemon) exists from Debian trixie onward. On
# bookworm/bullseye there is no such package and the client ships inside
# docker.io — which on trixie only *Recommends* docker-cli, so the fallback
# arm must NOT use --no-install-recommends or it installs a daemon and no
# client. The arm is chosen by package AVAILABILITY, not by install failure:
# a transient apt error must fail the build, not silently select the daemon.
RUN if [ "$WITH_DOCKER" = "1" ]; then apt-get update \
      && if apt-cache show docker-cli 2>/dev/null | grep -q '^Package: docker-cli'; then \
           apt-get install -y --no-install-recommends docker-cli; \
         else \
           apt-get install -y docker.io; \
         fi \
      && rm -rf /var/lib/apt/lists/*; fi

ARG WITH_SYSTEMS=0
# The package set cc's Systems feature needs; src/systems/fuse/preflight.ts is
# the authority for what must be present. gcc, libc6-dev, util-linux, mount,
# coreutils, mawk and sed are already on node:24-trixie (apt no-ops them) and
# are named so a CC_BASE_IMAGE / CC_BASE_IMAGE_FILE override still yields an
# image that satisfies preflight.
RUN if [ "$WITH_SYSTEMS" = "1" ]; then \
      if [ "$WITH_SUDO" != "1" ]; then \
        echo "FATAL (Dockerfile): CC_WITH_SYSTEMS=1 needs CC_WITH_SUDO=1 — preflight refuses the spawn at \`sudo -n true\`, so these packages could never be used." >&2; exit 1; \
      fi; \
      apt-get update \
      && apt-get install -y --no-install-recommends \
         fuse3 libfuse3-dev pkg-config gcc libc6-dev util-linux mount coreutils mawk sed \
      && rm -rf /var/lib/apt/lists/*; fi

ARG WITH_CLOUDFLARED=0
RUN if [ "$WITH_CLOUDFLARED" = "1" ]; then \
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg \
      && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list \
      && apt-get update && apt-get install -y cloudflared && rm -rf /var/lib/apt/lists/*; fi

ARG WITH_TAILSCALE=0
RUN if [ "$WITH_TAILSCALE" = "1" ]; then curl -fsSL https://tailscale.com/install.sh | sh; fi
# /var/run/tailscale — the default socket dir for tailscaled and the CLI — is
# root-owned; pre-create it world-writable so plain `tailscale up` needs no flags.
RUN if [ "$WITH_TAILSCALE" = "1" ]; then mkdir -p /var/run/tailscale && chmod 0777 /var/run/tailscale; fi

ARG WITH_OLLAMA=0
# The installer's payloads are zstd-compressed; it hard-fails extraction without the package.
RUN if [ "$WITH_OLLAMA" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends zstd \
      && rm -rf /var/lib/apt/lists/* \
      && curl -fsSL https://ollama.com/install.sh | sh; fi

ARG WITH_CLAUDE_CODE_PROXY=0
# claude-code-proxy serves an Anthropic-compatible API on 127.0.0.1:18765
# backed by a ChatGPT sign-in, and claude runs through it; the entrypoint
# starts `claude-code-proxy serve` detached at boot, the proxy is signed in
# inside the container (`claude-code-proxy codex auth login` — that codex
# subcommand is upstream naming), and routing claude at it is configured in
# cc's backends feature (docs/models.md → Backends) — see docker/README.md → Auth.
RUN if [ "$WITH_CLAUDE_CODE_PROXY" = "1" ]; then \
      curl -fsSL https://raw.githubusercontent.com/raine/claude-code-proxy/main/scripts/install.sh | bash; fi

COPY entrypoint.sh /usr/local/bin/cc-entrypoint
RUN chmod 0755 /usr/local/bin/cc-entrypoint
ENTRYPOINT ["/usr/local/bin/cc-entrypoint"]