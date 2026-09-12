# code-conductor image. Build context is this docker/ directory only — the
# repo itself is bind-mounted at runtime, so nothing from the repo is baked
# into the image.
# Debian trixie, not bookworm: the claude-code-proxy prebuilt binary (installed
# with CC_WITH_CLAUDE_CODE_PROXY=1) is dynamically linked and requires
# GLIBC 2.39; trixie ships 2.41, bookworm only 2.36.
FROM node:24-trixie

# The claude CLI is needed at session-spawn time; install it into the image so
# containers don't have to.
RUN npm install -g @anthropic-ai/claude-code

# WORKDIR is the PROJECTS ROOT, not the cc checkout, so `docker exec` /
# `docker compose exec` land in the projects dir by default. The entrypoint
# cds into the checkout (REPO_DIR) itself right before exec'ing.
WORKDIR /workspaces/projects

# ── Optional tooling, baked at build time only (all default OFF) ─────────
# Each install uses its upstream project's own install method. Nothing is
# ever downloaded
# at container startup; change the flags and rebuild (--build --pull).

ARG WITH_DOCKER=0
RUN if [ "$WITH_DOCKER" = "1" ]; then apt-get update \
      && apt-get install -y --no-install-recommends docker.io \
      && rm -rf /var/lib/apt/lists/*; fi

ARG WITH_CLOUDFLARED=0
RUN if [ "$WITH_CLOUDFLARED" = "1" ]; then \
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg \
      && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list \
      && apt-get update && apt-get install -y cloudflared && rm -rf /var/lib/apt/lists/*; fi

ARG WITH_TAILSCALE=0
RUN if [ "$WITH_TAILSCALE" = "1" ]; then curl -fsSL https://tailscale.com/install.sh | sh; fi

ARG WITH_OLLAMA=0
RUN if [ "$WITH_OLLAMA" = "1" ]; then curl -fsSL https://ollama.com/install.sh | sh; fi

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