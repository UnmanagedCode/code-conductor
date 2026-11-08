---
name: scripting
description: "Use when cc tool results need filtering or aggregating before you read them, or later calls depend on earlier results: with run_code, script the calls and return only the digest."
---

# Scripting cc

Two shapes call for a `run_code` program:
- aggregating: `project_status` of every project, `describe_session` of every live worker — many full results, of which you need only the digest;
- chaining: list, filter, then read or act on only what passed (move, update or log the matching cards), with a follow-up call only where a result calls for one.

A few small, independent reads need no program: make them as parallel tool calls.

Return only the digest, because the return value is what lands in your context.

```js
const out = [];
for (const { name } of (await cc.list_projects()).projects) {
  let s;
  try {
    s = await cc.project_status({ project: name, logLimit: 0 });
  } catch (e) {
    if (e.status !== 200) throw e;
    out.push(`${name}: refused ${e.code}`);
    continue;
  }
  if (!s.dirty) out.push(`${name}: ${s.gitRefusal ?? (s.isGitRepo === false ? 'not a git repo' : 'git status failed')}`);
  else out.push(`${name}: ${s.dirty.length ? s.dirty.length + ' dirty' : 'clean'}`);
}
return out;
```

- Leave an argument out rather than passing `null`, which is sent as a value. A worktree from `list_projects` is `worktrees[i].worktreeName`, passed as `worktree`; the main checkout takes no `worktree`.

## Rules

- **No project-tree writes from a program.** File edits, commits, merges and syncs never come from program calls. To change a project, spawn a worker in it; edit your own checkout with your own tools. Board operations and read-only `project_bash` (`git log`, `ls`) are fine.
- **A refusal is a result.** An error with `status` 200 is the tool's own refusal: branch on `code`, put it in the digest, and move on to the next target. A `status` ≥ 400 is a fault in your call (unknown tool, bad arguments): fix the program. Some "no" answers come back as results and are not thrown (a non-zero `exitCode`, `sync_worktree`'s `action`), so read the result.
