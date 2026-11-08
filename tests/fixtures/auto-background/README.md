# Auto-background capture fixtures

Real Claude Code CLI stdout streams, captured with `CLAUDE_AUTO_BACKGROUND_TASKS=1` against **Claude Code 2.1.316**, replayed through cc by `tests/replayLauncher.mjs` (rig: `tests/autoBackgroundReplay.mjs`).

Each line is one of: `{t, line}` (a stdout frame, `t` = seconds since the first prompt), `{t, stdin_sent}` (a prompt written to the CLI), `{t, sigterm_sent}`, `{t, stdin_closed}`, `{t, exit:{code, sig}}`, `{t, sigkill_max}` / `{t, idle_exit}` (the capturing harness's own cleanup; the replay skips them).

| Fixture | What the CLI did | Used by |
|---|---|---|
| `mcp-s150-flag1.stdout.ndjson` | a 150 s MCP call, backgrounded at the threshold; the CLI opens its own turn on completion | `tests/auto-background-replay-mcp.test.mjs` |
| `agent-fg-flag1.stdout.ndjson` | an Agent call with `run_in_background:false`, force-backgrounded; its subagent runs Bash | `tests/auto-background-replay-agent.test.mjs` |
| `mcp-bg-sigterm-flag1.stdout.ndjson` | SIGTERM while the backgrounded MCP task is pending | `tests/auto-background-replay-sigterm.test.mjs`, `tests/auto-background-replay-sigkill.test.mjs` (derived: SIGKILL instead) |
| `mcp-bg-stdin-close-flag1.stdout.ndjson` | stdin closed (cc's kill path) while the backgrounded MCP task is pending | `tests/auto-background-replay-kill.test.mjs` |

Scrubbed on capture and copy:

- session ids are `S1` (the replay substitutes the live one), cwd is `/tmp/CWD`, CLI temp paths are `<CLI_TMP>`;
- every `system/init`'s `mcp_servers` keeps only the capture's own `slow` test server, and is `[]` where the capture had none (both inits of `agent-fg-flag1`);
- only the keys listed above are kept (no wall-clock timestamps);
- stream deltas, thinking blocks, init `tools` and hook events were dropped; `message_start` / `message_stop` and `system/status` are kept.
