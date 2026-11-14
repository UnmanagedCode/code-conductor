import express from 'express';
import {
  removeWorktree, mergeWorktreeIntoParent, getWorktree, requireWorktree, syncWorktree, getProjectCommits, setWorktreeLock,
} from '../worktrees.ts';
import {
  getWorktreeDiff, getWorktreeFileDiff, getCommitDiff, getCommitFileDiff, getProjectUncommittedDiff, getProjectUncommittedFileDiff,
} from '../gitDiff.ts';
import { invalidate } from '../projectsCache.ts';
import type { InstanceLike, InstanceManagerLike } from '../instanceTypes.ts';
import { httpError } from '../httpError.ts';
import { jsonBody } from './shared.ts';

export function mountWorktrees(r: express.Router, { instances }: { instances?: InstanceManagerLike | null }): void {
  // Structured diff for a worktree vs its base branch. Without ?path=,
  // returns a per-file summary (no hunks, never truncated); with ?path=,
  // returns that one file's hunks (fetched lazily by the review UI on
  // expand). Accepts optional ?baseRef= and ?context= (clamped to the
  // range/default enforced in getWorktreeDiff/getWorktreeFileDiff).
  r.get('/projects/:name/worktrees/:wt/diff', async (req, res, next) => {
    try {
      const baseRef = typeof req.query.baseRef === 'string' ? req.query.baseRef : undefined;
      const contextLines = req.query.context !== undefined ? Number(req.query.context) : 3;
      const filePath = typeof req.query.path === 'string' && req.query.path ? req.query.path : null;
      const result = filePath
        ? await getWorktreeFileDiff(req.params.name, req.params.wt, filePath, { baseRef, contextLines })
        : await getWorktreeDiff(req.params.name, req.params.wt, { baseRef, contextLines });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Commit history (git log) for a project's current branch (HEAD), newest
  // first and topologically ordered (see `getProjectCommits`). Accepts optional
  // ?limit= (default `COMMITS_DEFAULT_LIMIT`, max `COMMITS_MAX_LIMIT`). Returns
  // { project, branch, commits, truncated, limit }.
  r.get('/projects/:name/commits', async (req, res, next) => {
    try {
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
      const result = await getProjectCommits(req.params.name, { limit });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Diff of all uncommitted changes (staged + unstaged vs HEAD). Mirrors the
  // commit /diff response shape (summary without ?path=, one file's hunks
  // with ?path=) so the same client renderer applies.
  // Registered before the :sha route so the literal "uncommitted" isn't
  // treated as a SHA param.
  r.get('/projects/:name/commits/uncommitted/diff', async (req, res, next) => {
    try {
      const contextLines = req.query.context !== undefined ? Number(req.query.context) : 3;
      const filePath = typeof req.query.path === 'string' && req.query.path ? req.query.path : null;
      const result = filePath
        ? await getProjectUncommittedFileDiff(req.params.name, filePath, { contextLines })
        : await getProjectUncommittedDiff(req.params.name, { contextLines });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Structured diff for the change introduced by a single commit. Mirrors the
  // worktree /diff response shape (summary without ?path=, one file's hunks
  // with ?path=) so the same client renderer applies. Accepts optional
  // ?context= (clamped to the range/default enforced in getCommitDiff/getCommitFileDiff).
  r.get('/projects/:name/commits/:sha/diff', async (req, res, next) => {
    try {
      const contextLines = req.query.context !== undefined ? Number(req.query.context) : 3;
      const filePath = typeof req.query.path === 'string' && req.query.path ? req.query.path : null;
      const result = filePath
        ? await getCommitFileDiff(req.params.name, req.params.sha, filePath, { contextLines })
        : await getCommitDiff(req.params.name, req.params.sha, { contextLines });
      res.json(result);
    } catch (e) { next(e); }
  });

  // The same three commit surfaces, addressed at one of the project's
  // worktrees. Query params and response shapes are the project-scoped routes'
  // above, with `:name` naming the PARENT project; the canonical worktree dir
  // name is echoed back. A worktree unknown under that project is a 404.
  // This is the only addressing form that reaches a worktree of a project on a
  // system: its tree is beside the parent's ON that system, so no project name
  // resolves to it.
  r.get('/projects/:name/worktrees/:wt/commits', async (req, res, next) => {
    try {
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
      const result = await getProjectCommits(req.params.name, { limit, worktree: req.params.wt });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Registered before the :sha route so the literal "uncommitted" isn't
  // treated as a SHA param — as the project-scoped pair already is.
  r.get('/projects/:name/worktrees/:wt/commits/uncommitted/diff', async (req, res, next) => {
    try {
      const contextLines = req.query.context !== undefined ? Number(req.query.context) : 3;
      const filePath = typeof req.query.path === 'string' && req.query.path ? req.query.path : null;
      const worktree = req.params.wt;
      const result = filePath
        ? await getProjectUncommittedFileDiff(req.params.name, filePath, { contextLines, worktree })
        : await getProjectUncommittedDiff(req.params.name, { contextLines, worktree });
      res.json(result);
    } catch (e) { next(e); }
  });

  r.get('/projects/:name/worktrees/:wt/commits/:sha/diff', async (req, res, next) => {
    try {
      const contextLines = req.query.context !== undefined ? Number(req.query.context) : 3;
      const filePath = typeof req.query.path === 'string' && req.query.path ? req.query.path : null;
      const worktree = req.params.wt;
      const result = filePath
        ? await getCommitFileDiff(req.params.name, req.params.sha, filePath, { contextLines, worktree })
        : await getCommitDiff(req.params.name, req.params.sha, { contextLines, worktree });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Land-back for the commits view, addressed by worktree like the routes
  // above (`:name` is the PARENT project) — no instance needs to exist.
  // Measure the worktree against its parent's baseBranch and land what git
  // can do alone (FF or auto-rebase). Never prompts an agent: a blocked sync
  // comes back as ok:true + action (commit-required | rebase-conflict) with the
  // rendered rebasePrompt, same as POST /instances/:id/sync.
  r.post('/projects/:name/worktrees/:wt/sync', async (req, res, next) => {
    try {
      const wt = await requireWorktree(req.params.name, req.params.wt);
      const result = await syncWorktree(req.params.name, wt.worktreeName);
      invalidate(req.params.name);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Merge the worktree's branch into the parent repo with a real merge
  // commit (--no-ff). Refuses with a friendly reason if the worktree
  // hasn't been synced yet (parent has commits the worktree branch
  // doesn't carry — the merge would still work, but conflicts would
  // pop on the parent side instead of being resolved inside the worktree
  // where the agent can help). Returns {ok:true, newSha} or
  // {ok:false, reason} — callers render the reason inline rather than
  // treating non-mergeable states as a server error.
  r.post('/projects/:name/worktrees/:wt/merge', async (req, res, next) => {
    try {
      const wt = await requireWorktree(req.params.name, req.params.wt);
      // The behind-guard lives inside mergeWorktreeIntoParent (shared with the
      // MCP handler); map its typed refusal to this surface's exact wording
      // + status (HTTP 200, no cache invalidation — nothing changed).
      const allowDirty = jsonBody(req).allowDirty === true;
      const result = await mergeWorktreeIntoParent(req.params.name, wt.worktreeName, { allowDirty });
      if (result.ok === false && result.code === 'WORKTREE_BEHIND') {
        res.json({
          ok: false,
          reason: `worktree is behind '${result.baseBranch}' by ${result.behind} commit(s) — click Sync first to fast-forward / rebase`,
        });
        return;
      }
      invalidate(req.params.name);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Set or clear the user's lock on a worktree (see WorktreeMeta.locked). The
  // only writer that clears it, or sets it on an existing worktree: there is no
  // MCP twin, by design (MCP create_worktree can only set it at creation).
  r.put('/projects/:name/worktrees/:wt/lock', async (req, res, next) => {
    try {
      const locked = jsonBody(req).locked;
      if (typeof locked !== 'boolean') throw httpError(400, 'locked must be a boolean');
      const result = await setWorktreeLock(req.params.name, req.params.wt, locked);
      invalidate(req.params.name);
      res.json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  // Remove a worktree. Refuses if there's a live instance attached or
  // the worktree has uncommitted changes (unless ?force=1). The user's lock
  // does not apply here: this is the human's delete, and only MCP
  // delete_worktree refuses a locked worktree.
  r.delete('/projects/:name/worktrees/:wt', async (req, res, next) => {
    try {
      const force = req.query.force === '1' || req.query.force === 'true';
      // Canonicalize once before the guards: idsForWorktree is an exact
      // in-memory compare, so a bare-slug delete would see no attached
      // instances and skip the live-instance refusal entirely (and under
      // force, never kill them before the directory is yanked).
      const wtName = (await getWorktree(req.params.name, req.params.wt))?.worktreeName ?? req.params.wt;
      if (instances) {
        const running = instances.idsForWorktree(req.params.name, wtName)
          .map(id => instances.get(id))
          .filter((i): i is InstanceLike => !!i && !!i.proc);
        if (running.length > 0 && !force) {
          throw httpError(409,
            `worktree has ${running.length} running instance(s) — kill them first or pass force=1`,
          );
        }
        // With force, kill any attached instances before removing.
        if (force) {
          await Promise.all(running.map(i => i.kill({ graceMs: 300, actor: { type: 'human' } }).catch(() => {})));
        }
      }
      // INVALIDATE ON THE THROW PATH TOO, because the removal MUTATES before it
      // can throw: `git worktree remove` succeeds, the store entry is dropped,
      // and only then can the best-effort branch delete raise a system refusal.
      // Called on the success path alone, the cached row went on listing a
      // worktree the call had already removed until the TTL expired, so a client
      // that re-fetched on the 502 was handed it back and got a 404 for clicking
      // it. A refusal that changed nothing pays one recompute for the same
      // call. This held before the store entry moved above the branch delete
      // too — the DIRECTORY was already gone at that throw, and listWorktrees
      // prunes by `git worktree list`, so the cached row was already the only
      // thing still showing it. (card 2026-0308 §G10, superseding §1.5.)
      try {
        await removeWorktree(req.params.name, wtName, { force });
      } finally {
        invalidate(req.params.name);
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}
