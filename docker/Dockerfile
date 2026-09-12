# code-conductor image. Build context is this docker/ directory only — the
# repo itself is bind-mounted at runtime, so nothing from the repo is baked
# into the image.
FROM node:24-bookworm

# The claude CLI is needed at session-spawn time; install it into the image so
# containers don't have to.
RUN npm install -g @anthropic-ai/claude-code

# WORKDIR is the PROJECTS ROOT, not the cc checkout, so `docker exec` /
# `docker compose exec` land in the projects dir by default. The entrypoint
# cds into the checkout (REPO_DIR) itself right before exec'ing.
WORKDIR /workspaces/projects

# ── Optional tooling, baked at build time only (all default OFF) ─────────
# Each install uses the devcontainer's own method. Nothing is ever downloaded
# at container startup; change the flags and rebuild (--build --pull).

ARG WITH_DOCKERIO=0
RUN if [ "$WITH_DOCKERIO" = "1" ]; then apt-get update \
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

ARG WITH_CODEX=0
# One flag installs codex AND claude-code-proxy (its required companion —
# codex runs through the proxy; installed via the upstream install script).
RUN if [ "$WITH_CODEX" = "1" ]; then npm install -g @openai/codex \
      && curl -fsSL https://raw.githubusercontent.com/raine/claude-code-proxy/main/scripts/install.sh | bash; fi

COPY entrypoint.sh /usr/local/bin/cc-entrypoint
RUN chmod 0755 /usr/local/bin/cc-entrypoint
ENTRYPOINT ["/usr/local/bin/cc-entrypoint"]