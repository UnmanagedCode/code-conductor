---
name: worktree-hooks
description: "Use when writing, debugging or choosing where to put a cc worktree hook (post-worktree-create.sh / post-worktree-merge.sh), or reading a postWorktreeCreate / postWorktreeMerge result."
---

# cc worktree hooks

## Events

| Event | Script | Runs when | cwd | Extra vars |
|---|---|---|---|---|
| create | `post-worktree-create.sh` | after cc creates a worktree (spawn with a worktree, `create_worktree`), before any session starts in it | the new worktree | — |
| merge | `post-worktree-merge.sh` | after a merge into the parent has landed; never for a refused merge | the merge target: the project root, or the feature checkout when a task merges into its base | `CC_PRE_MERGE_SHA`, `CC_POST_MERGE_SHA`; on cc's machine also `CC_SERVER_NODE`; when the target is the running cc server's own checkout, `CC_SERVER_BOOT_SHA` (the commit it booted from) or else `CC_SERVER_BOOT_UNKNOWN` (why it can't vouch for one) |

- One script per event (`WORKTREE_HOOKS`): to combine recipes, put them in that one file.
- The merge hook is read from the target **after** the merge, so a branch that edits the in-tree hook runs its own version on landing.
- Merge hooks run one at a time per project, and the merge response waits for the hook.

## How it runs

- cc runs `env CC_…=… bash <script>` on the project's system, with that system's PATH. The shebang and exec bit are ignored, and cc never chmods the script.
- Every hook gets `CC_WORKTREE_PATH`, `CC_PROJECT_NAME`, `CC_BRANCH`, `CC_BASE_BRANCH` and `CC_PARENT_PATH`: the checkout the worktree was branched from and merges into (for a merge hook, the target).
- What a merge brought in: `git diff --name-only "$CC_PRE_MERGE_SHA" "$CC_POST_MERGE_SHA"`.
- `CC_SERVER_NODE` is the node binary running cc: use `"${CC_SERVER_NODE:-node}"` so the hook also runs without cc.
- To test a create hook by hand, run the same argv from the worktree:
  ```sh
  env CC_WORKTREE_PATH="$PWD" CC_PROJECT_NAME=<project> CC_BRANCH=<branch> CC_BASE_BRANCH=<base> CC_PARENT_PATH=<parent checkout> bash <script>
  ```
  For a merge hook, run it from the target with `CC_WORKTREE_PATH=<merged worktree>` and add `CC_PRE_MERGE_SHA=<sha> CC_POST_MERGE_SHA=<sha>`.

## Reading the result

Reported as `postWorktreeCreate` (spawn and `create_worktree` results) and `postWorktreeMerge` (successful `merge_worktree` and REST merge results), one shape: `{ ran, source?, exitCode, durationMs, output, truncated?, timedOut?, descendantsMaySurvive?, skipped?, error? }`.

| You see | It means |
|---|---|
| `ran: false`, no `skipped` and no `error` | no script found in either location (see Placement) |
| `skipped: 'disabled'` | the event's kill switch is set: `ORCH_DISABLE_POST_WORKTREE_HOOK=1` (create), `ORCH_DISABLE_POST_WORKTREE_MERGE_HOOK=1` (merge) |
| `skipped: 'STORE_HOOK_LOCAL_ONLY'` | a store hook on a project that lives on a remote system: move it in-tree |
| `source` | `'in-tree'` or `'store'`: which location was resolved (also set on a `STORE_HOOK_LOCAL_ONLY` skip, where nothing ran) |
| `timedOut: true`, `exitCode: null` | killed at the timeout: 120 s default (`WORKTREE_HOOK_TIMEOUT_MS`), raised per event by `ORCH_POST_WORKTREE_TIMEOUT_MS` / `ORCH_POST_WORKTREE_MERGE_TIMEOUT_MS` on the cc server |
| `descendantsMaySurvive: true` | only `bash` was killed; what it started (an install) may still be running |
| `error: true` | the script could not be started, or resolving it threw; `output` holds the message |
| `truncated: true` | `output` is the tail only (`HOOK_OUTPUT_CAP`, 16 KB) |

- A hook never fails its operation: the worktree stays created and the merge stays landed (`ok: true`) whatever the hook reports.
- The create result is also kept on the session: a session spawned with a worktree carries it as `worktree.postWorktreeCreate` in `list_sessions` / `describe_session` and every client's session list, so a worker or conductor can read it there later.
- The merge result is only returned to the caller, never stored.
- The web UI shows a create result in the spawn dialog when `ran` is true, and a merge result in the merge toast, whose failure warning quotes only the last lines of `output`. **Print the line that matters last.**
- **Never print secrets**: a create hook's `output` reaches every client that lists the session.
- A merge waits for its hook inside the server's HTTP request timeout (300 s, Node's default `requestTimeout`): a merge timeout raised past it drops the merge response while the merge has still landed.

## Placement: in-repo vs out-of-repo

cc takes the first script it finds, in this order:
1. in-tree: `<parent checkout>/.code-conductor/<script>`, read from the parent's disk, so it need not be committed;
2. store: `$CC_PROJECTS_ROOT/.code-conductor/projects/<project>/<script>`.

| | A: tracked in-tree | B: untracked in-tree, excluded | C: cc's store |
|---|---|---|---|
| Shared with other clones | yes | no | no |
| Versioned, and a branch can change it | yes | no | no |
| Remote-system projects | runs | runs | skipped `STORE_HOOK_LOCAL_ONLY` |
| Derived worktrees (`baseWorktree`) | runs: read from the base's checkout, which has it | **does not run**: the base's checkout has no copy | runs |
| Must not dirty the merge target | committed | needs the exclude line, or every merge into the root is refused `PARENT_DIRTY` (no override) | outside the tree |

Use A when the hook is part of the project, C for setup specific to this machine, and B only for a one-machine hook on a remote-system project. The samples below take `SRC` (the script to install) and `HOOK` (its script name); run A and B from the project root (the main checkout).

```bash place-tracked
mkdir -p .code-conductor
cp "$SRC" ".code-conductor/$HOOK"
git add ".code-conductor/$HOOK"
git commit -q -m "Add the $HOOK worktree hook"
```

```bash place-untracked
mkdir -p .code-conductor
cp "$SRC" ".code-conductor/$HOOK"
EXCLUDE="$(git rev-parse --git-path info/exclude)"
mkdir -p "$(dirname "$EXCLUDE")"
if ! grep -qxF '/.code-conductor/' "$EXCLUDE" 2>/dev/null; then
  if [ -s "$EXCLUDE" ] && [ -n "$(tail -c1 "$EXCLUDE")" ]; then echo >> "$EXCLUDE"; fi
  echo '/.code-conductor/' >> "$EXCLUDE"
fi
```

`.code-conductor` is a real directory, so its pattern may end in `/`; a symlink's may not (recipe 2).

```bash place-store
DEST="$CC_PROJECTS_ROOT/.code-conductor/projects/$PROJECT"
mkdir -p "$DEST"
cp "$SRC" "$DEST/$HOOK"
```

## Recipes

### 1. Create: link dependencies from the parent

- **When:** installs are slow or unreliable, and worktrees can share the parent's dependency versions.
- **Costs:**
  - A worktree has no dependencies of its own: a branch that changes `package.json` runs against the parent's `node_modules` until the change reaches a checkout recipe 4 reinstalls in (the main checkout; a task landing in a feature checkout is not enough).
  - `npm install` inside the worktree writes through the link into the parent's tree. Build and run there with the project's scripts, never `npm install`.
- Link it from the sample below with `node_modules` in `LINKS`.

### 2. Create: link other untracked or ignored files

For `.env`, local config, or an out-of-tree directory. The sample handles the exclude:
- `git rev-parse --git-path info/exclude` is the **common** git dir's file even from a worktree, so one entry covers the main checkout and every worktree.
- The entry is `/<name>` with **no trailing slash**: git sees a symlink as a file, and `<name>/` does not match it. A project whose `.gitignore` has only `node_modules/` sees the linked `node_modules` as untracked.
- An unignored link makes the worktree dirty: `merge_worktree` refuses `WORKTREE_DIRTY` (override `allowDirty`), and so does `delete_worktree` (override `force`).

```bash create-link-from-parent
# post-worktree-create.sh: link untracked files from the parent checkout.
set -e
PARENT="${CC_PARENT_PATH:?}"
LINKS="node_modules .env"
EXCLUDE="$(git rev-parse --git-path info/exclude)"
mkdir -p "$(dirname "$EXCLUDE")"
for name in $LINKS; do
  if ! grep -qxF "/$name" "$EXCLUDE" 2>/dev/null; then
    if [ -s "$EXCLUDE" ] && [ -n "$(tail -c1 "$EXCLUDE")" ]; then echo >> "$EXCLUDE"; fi
    echo "/$name" >> "$EXCLUDE"
  fi
  if [ -e "$name" ] || [ -L "$name" ]; then
    echo "[post-worktree-create] $name: already present, left alone"
  elif [ ! -e "$PARENT/$name" ]; then
    echo "[post-worktree-create] WARNING: $PARENT/$name not found, not linked" >&2
  else
    ln -s "$PARENT/$name" "$name"
    echo "[post-worktree-create] $name: linked from $PARENT"
  fi
done
```

- Safe to re-run: existing entries and links (dangling ones included) are left alone.
- A missing source warns and continues; the hook still exits 0.

### 3. Merge: delegate the decision to a program in the repo

- Keep the tracked `.sh` a shim: `exec "${CC_SERVER_NODE:-node}" <tracked program> "${CC_PRE_MERGE_SHA:?}" "${CC_POST_MERGE_SHA:?}"`.
- The program diffs `PRE..POST`, does nothing when the target is a linked worktree (`git rev-parse --git-dir` ≠ `--git-common-dir`) or nothing relevant changed, otherwise chooses between applying now and preparing for the next start. It writes only ignored paths and prints one line naming the action and why.
- When the project is cc itself, `CC_SERVER_BOOT_SHA` is what tells "apply now" from "prepare for the next start": the running server's code is that commit, so diff it against `POST` to see whether the change is safe to apply live. With `CC_SERVER_BOOT_UNKNOWN` or neither var set, prepare.
- The logic is then versioned and unit-testable, and a branch's new logic runs on its own landing.

### 4. Merge: reinstall dependencies when they changed

Pairs with recipe 1: with linked `node_modules`, the install in the main checkout refreshes every worktree.

```bash merge-install-deps
# post-worktree-merge.sh: reinstall dependencies when the merge changed them.
set -e
dirs=$(git rev-parse --path-format=absolute --git-dir --git-common-dir)
if [ "$(echo "$dirs" | sed -n 1p)" != "$(echo "$dirs" | sed -n 2p)" ]; then
  echo "[post-worktree-merge] deps: linked worktree, skipped"; exit 0
fi
if git diff --quiet "${CC_PRE_MERGE_SHA:?}" "${CC_POST_MERGE_SHA:?}" -- package.json package-lock.json; then
  echo "[post-worktree-merge] deps: unchanged"; exit 0
fi
npm ci
echo "[post-worktree-merge] deps: reinstalled"
```

- **`npm ci`, not `npm install`.** `npm install` may rewrite `package-lock.json`, which dirties the target, and the next merge is refused `PARENT_DIRTY` with no override. `npm ci` never writes `package.json` or the lockfile, and fails instead when they disagree.
- `npm ci` deletes `node_modules` first, so linked worktrees have no dependencies until it finishes.
- A merge into a feature worktree skips: its dependencies are the root's, refreshed when the feature lands there.
- The merge response, and every merge queued behind it, waits for the install. Check it fits the timeout (Reading the result); after `timedOut` with `descendantsMaySurvive`, the install may still be running.
- Write only ignored paths. For another package manager, swap in its frozen-lockfile install and its manifest and lockfile names.
