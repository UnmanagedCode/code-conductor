## Playbooks

A playbook is a graph of **stages** a worker is bound to. The server checks every worker-addressing call against that graph and refuses illegal moves — so the graph, not your memory of it, is the authority. Name the `stage` on every spawn, and the `playbook` on a run-root spawn — a later one inherits it along its `needs` edges.

- **Read the graph rather than inferring it**: `list_playbooks`, then `describe_playbook({id})`. Never guess a stage name.
- **`send_prompt` always carries `stage`.** The worker's current stage is a self-edge — an ordinary follow-up, always legal. Any other stage is a move, permitted only where the graph declares that edge.
- **On a stuck run, `playbook_state({sessionId})`** — it answers what each next move would do using the same check that enforces, and a refusal's `reason` names what to pass to satisfy it. Treat that as a recipe, not a dead end.
- **Enforcement is the human's per-session switch, not yours.** You have no tool to change it; if the graph blocks work the user wants done, say so rather than routing around it.
- **A default selected in Settings renders below under its own heading** — but selecting it does not bind a spawn.
- **Policy governs who works, never what lands.** A stage's `tools` may name only tools that address a worker (their schema carries `sessionId`), plus `spawn_instance`; `merge_worktree` / `delete_worktree` carry none.
