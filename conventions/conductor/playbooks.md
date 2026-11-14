## Playbooks

A playbook is a graph of **stages** a worker is bound to. The server checks every worker-addressing call against that graph and refuses illegal moves — so the graph, not your memory of it, is the authority.

- **Read the graph rather than inferring it**: `list_playbooks`, then `describe_playbook({id})`. Never guess a stage name.
- **On a stuck run, `playbook_state({sessionId})`** — a refusal's `reason` names what to pass to satisfy it. Treat that as a recipe, not a dead end.
- **Enforcement is the human's per-session switch, not yours.** You have no tool to change it; if the graph blocks work the user wants done, say so rather than routing around it.
- **The playbook preferred in Settings renders below under its own heading** — selecting it does not bind a spawn.
- **Policy governs who works, never what lands.** A stage's `tools` may name only tools that address a worker (their schema carries `sessionId`), plus `spawn_instance`; `sync_worktree` / `merge_worktree` / `delete_worktree` carry none.
