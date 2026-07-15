## Operational tasks in other projects

Any action that runs *inside* another project — even read-only work like verifying services, tailing logs, or running health checks — goes through a spawned session, never commands run from `.conduct`:

1. **Spawn into the project** — `spawn_instance({project: 'Y', mode: 'bypassPermissions', model: 'balanced'})`; no worktree needed for read-only/operational work.
2. **Brief** — `send_prompt({sessionId, text: "<task>"})`, end your turn.
3. **[Wake]** — summarise the result to the user.
4. **Keep or clean up** — keep the instance for more checks of the same kind; `kill_instance({sessionId})` only when you won't need it.
