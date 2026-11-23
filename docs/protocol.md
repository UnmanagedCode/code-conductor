# Protocol

> See also: [README](../README.md)
>
> This file is the protocol between cc and the **Claude CLI / its own clients** — the subprocess stream, the WebSocket messages, the REST and MCP surface. The protocol between cc and a **System provider** (the NDJSON stdio contract for running commands and reading/writing files on another machine) is its own document: [systems-protocol.md](systems-protocol.md).

## [subprocess.md](protocol/subprocess.md) — the CLI stream, its hooks and the session env

- [Subprocess protocol](protocol/subprocess.md#subprocess-protocol)

## [websocket.md](protocol/websocket.md) — the handshake and the client/server message types

- [WebSocket protocol](protocol/websocket.md#websocket-protocol)

## [ws-events.md](protocol/ws-events.md) — event kinds, their fields and the instance summary

- [WebSocket event payloads](protocol/ws-events.md#websocket-event-payloads)

## [rest.md](protocol/rest.md) — error bodies, caching, and the project and session endpoints

- [REST endpoints](protocol/rest.md#rest-endpoints)

## [rest-instances.md](protocol/rest-instances.md) — instance, worktree, commit and admin endpoints, event paging and lineage

- [REST endpoints: instances, worktrees and admin](protocol/rest-instances.md#rest-endpoints-instances-worktrees-and-admin)

## [rest-settings.md](protocol/rest-settings.md) — settings, voice, auth and cost endpoints, response headers and static routes

- [REST endpoints: settings, voice, auth and costs](protocol/rest-settings.md#rest-endpoints-settings-voice-auth-and-costs)
- [Base path and reverse proxies](protocol/rest-settings.md#base-path-and-reverse-proxies) — `CC_BASE_PATH`, both proxy styles, the proxy contract

## [headless.md](protocol/headless.md) — the headless run's output: the result, its exit codes and the output formats

- [Headless run result](protocol/headless.md#headless-run-result)
- [Output formats](protocol/headless.md#output-formats)
- [Replay result](protocol/headless.md#replay-result)

## [mcp.md](protocol/mcp.md) — params, session resolution, renewal and idle wake

- [MCP tool protocol](protocol/mcp.md#mcp-tool-protocol)

## [mcp-results.md](protocol/mcp-results.md) — validation, result budget and format, rendered reads, refusals

- [MCP tool results and refusals](protocol/mcp-results.md#mcp-tool-results-and-refusals)

## [playbooks.md](protocol/playbooks.md) — the playbook wire contract, worker tools and its REST surface

- [Playbooks](protocol/playbooks.md#playbooks)

## [fuse-event-log.md](protocol/fuse-event-log.md) — the event log file format

- [The FUSE-union daemon's policy event log](protocol/fuse-event-log.md#the-fuse-union-daemons-policy-event-log)

## Plugin system

The plugin manifest schema, reverse proxy (`/plugins/<id>/*`), bridge protocol, `/api/plugins` REST surface, **child MCP wire contract**, Plugin Library, and compliance checklist have moved to [docs/plugins.md](plugins.md).
