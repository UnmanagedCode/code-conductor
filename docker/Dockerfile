# code-conductor image. Build context is this docker/ directory only — the
# repo itself is bind-mounted at runtime, so nothing from the repo is baked
# into the image.
# Debian trixie, not bookworm: the claude-code-proxy prebuilt binary (installed
# with CC_WITH_CODEX=1) is dynamically linked and requires GLIBC 2.39; trixie
# ships 2.41, bookworm only 2.36.
FROM node:24-trixie

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
# One flag installs codex AND claude-code-proxy (upstream install script).
# The proxy serves an Anthropic-compatible API on 127.0.0.1:18765 backed by a
# ChatGPT sign-in; claude runs through it. `claude-via-codex` is the CLAUDE_BIN
# wrapper that routes claude at the proxy (see docker/README.md → Auth).
RUN if [ "$WITH_CODEX" = "1" ]; then npm install -g @openai/codex \
      && curl -fsSL https://raw.githubusercontent.com/raine/claude-code-proxy/main/scripts/install.sh | bash \
      && printf '%s\n' '#!/usr/bin/env bash' \
           'export ANTHROPIC_BASE_URL=http://127.0.0.1:18765' \
           'export ANTHROPIC_AUTH_TOKEN=unused' \
           'exec claude "$@"' > /usr/local/bin/claude-via-codex \
      && chmod 0755 /usr/local/bin/claude-via-codex; fi

COPY entrypoint.sh /usr/local/bin/cc-entrypoint
RUN chmod 0755 /usr/local/bin/cc-entrypoint
ENTRYPOINT ["/usr/local/bin/cc-entrypoint"]