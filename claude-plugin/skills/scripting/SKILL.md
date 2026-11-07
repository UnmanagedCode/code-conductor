---
name: scripting
description: "Use when one cc task needs the same tool across many projects, cards or sessions, or a chain of reads ending in a digest: script the calls instead of one tool call each."
---

# Scripting cc

Script cc when one task needs the same tool across many targets, or several chained reads that end in one summary:
- read-only fan-out: `project_status` of every project, `describe_session` of every live worker;
- multi-step recon: list, filter, read, then print a digest;
- bulk board operations: move, update or log many cards.

Print only the digest, because the script's stdout is what lands in your context. Run the script from a heredoc (`node --input-type=module - <<'EOF'`, `python3 - <<'EOF'`) so no file lands in a project tree.

## The client

`$CONDUCTOR_MCP_CLIENT_DIR` holds a generated client with one method per cc tool. Its calls go to `$CONDUCTOR_MCP_URL`, which is your own session, so cc attributes them to you. If `CONDUCTOR_MCP_CLIENT_DIR` is unset, this session has no script route to cc: make the tool calls directly. Node is always present where cc runs; Python needs 3.11+.

```js
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { ConductorClient, ConductorError } = await import(
  pathToFileURL(path.join(process.env.CONDUCTOR_MCP_CLIENT_DIR, 'conductor_client.mjs')).href);
const cc = new ConductorClient();

for (const { name } of (await cc.list_projects()).projects) {
  let s;
  try {
    s = await cc.project_status({ project: name, logLimit: 0 });
  } catch (e) {
    if (!(e instanceof ConductorError) || e.status !== 200) throw e;
    console.log(`${name}: refused ${e.code}`);
    continue;
  }
  if (!s.dirty) console.log(`${name}: ${s.gitRefusal ?? (s.isGitRepo === false ? 'not a git repo' : 'git status failed')}`);
  else console.log(`${name}: ${s.dirty.length ? s.dirty.length + ' dirty' : 'clean'}`);
}
```

```python
import os, sys

sys.path.insert(0, os.environ['CONDUCTOR_MCP_CLIENT_DIR'])
from conductor_client import ConductorClient, ConductorError

cc = ConductorClient()
for p in cc.list_projects()['projects']:
    name = p['name']
    try:
        s = cc.project_status(project=name, logLimit=0)
    except ConductorError as e:
        if e.status != 200:
            raise
        print(f'{name}: refused {e.code}')
        continue
    if 'dirty' not in s:
        print(f"{name}: {s.get('gitRefusal') or ('not a git repo' if s.get('isGitRepo') is False else 'git status failed')}")
    else:
        print(f"{name}: {len(s['dirty'])} dirty" if s['dirty'] else f'{name}: clean')
```

- Arguments use the tool's own names. In Node they go in one object; in Python they are keywords, and a name that is a Python keyword takes a `_` suffix (`from_=`).
- Leave an argument out rather than passing `None`/`null`, which is sent as a value. A worktree from `list_projects` is `worktrees[i].worktreeName`, passed as `worktree`; the main checkout takes no `worktree`.
- A method returns the tool's JSON result. Before you guess at field names, grep the method in `conductor_client.mjs` / `.py`: its doc comment and its `<Tool>Result` type list them.
- Plugin tools have no method. Call them with `cc.call('<plugin-id>__<tool>', {…})`; `GET $CONDUCTOR_MCP_URL/tools` lists every tool with its `inputSchema`. A plugin result is `{content}`: parse its text blocks. A plugin's tool-level failure raises `ConductorError` like a core refusal. code-kanban reports its own refusals inside the result instead: its first block is JSON that can carry `ok: false` and a `code`.

## Rules

- **Your role's limits apply unchanged.** A call you may not make directly, a script may not make either.
- **Dispatch, then exit.** A script may `spawn_instance` or `send_prompt`, and must exit right after. Each target's turn end wakes your session just as a direct call would. Never wait on a worker in a script: no `describe_session` or `get_recent_messages` loops, no sleeps.
- **No project-tree writes from a script.** File edits, commits, merges and syncs never come from script calls. To change a project, spawn a worker in it; edit your own checkout with your own tools. Board operations and read-only `project_bash` (`git log`, `ls`) are fine.
- **A refusal is a result.** `ConductorError` with `status` 200 is the tool's own refusal: branch on `code`, put it in the digest, and move on to the next target. A `status` ≥ 400 is a fault in your call (unknown tool, bad arguments): fix the script. Some "no" answers come back as results and are not raised (a non-zero `exitCode`, `sync_worktree`'s `action`), so read the result.
