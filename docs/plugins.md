# Plugin system

> See also: [README](../README.md)


Building a plugin's UI (the host contract, security advisories, an optional reference setup): [docs/plugin-ui.md](plugin-ui.md).

## [manifest.md](plugins/manifest.md) — the `conductor.plugin.json` schema

- [Manifest — `conductor.plugin.json` at the plugin project root](plugins/manifest.md#manifest--conductorpluginjson-at-the-plugin-project-root)

## [runtime.md](plugins/runtime.md) — reverse proxy, bridge, host exec and terminal, theme, auto-start, backend logs and exit history

- [Reverse proxy — `/plugins/<id>/*`](plugins/runtime.md#reverse-proxy--pluginsid)
- [Bridge protocol — `/pluginBridge.js`](plugins/runtime.md#bridge-protocol--pluginbridgejs)
- [Host exec — `POST /api/exec`](plugins/runtime.md#host-exec--post-apiexec)
- [Host terminal — `GET /api/terminal` (WebSocket)](plugins/runtime.md#host-terminal--get-apiterminal-websocket)
- [Theme stylesheet — `/pluginTheme.css`](plugins/runtime.md#theme-stylesheet--pluginthemecss)
- [Authoring playbooks from a plugin](plugins/runtime.md#authoring-playbooks-from-a-plugin)
- [Auto-start](plugins/runtime.md#auto-start)
- [Backend output and exit history](plugins/runtime.md#backend-output-and-exit-history)

## [rest.md](plugins/rest.md) — `/api/plugins`, the Plugin Library and its catalogs

- [REST — `/api/plugins`](plugins/rest.md#rest--apiplugins)

## [tools.md](plugins/tools.md) — MCP forwarding, tool audience, typed tools, the compliance checklist

- [Plugin MCP forwarding — child wire contract (pinned)](plugins/tools.md#plugin-mcp-forwarding--child-wire-contract-pinned)
- [Tool audience](plugins/tools.md#tool-audience)
- [Typed plugin tools (both formats)](plugins/tools.md#typed-plugin-tools-both-formats)
- [Plugin-compliance checklist](plugins/tools.md#plugin-compliance-checklist)
