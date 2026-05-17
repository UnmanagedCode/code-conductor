import express from 'express';
import { listProjects, createProject, listSessions, listSessionsForCwd } from './projects.js';
import {
  isGitRepo, listWorktrees, removeWorktree, fastForwardParent,
  buildRebasePrompt, getWorktree,
} from './worktrees.js';

export function buildRoutes({ instances } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  r.get('/projects', async (req, res, next) => {
    try {
      const projects = await listProjects();
      const enriched = await Promise.all(projects.map(async (p) => ({
        ...p,
        instanceIds: instances ? instances.idsForProject(p.name) : [],
        isGitRepo: await isGitRepo(p.path),
        worktrees: await listWorktrees(p.name).catch(() => []),
      })));
      res.json(enriched);
    } catch (e) { next(e); }
  });

  r.post('/projects', async (req, res, next) => {
    try {
      const { name } = req.body ?? {};
      const created = await createProject(name);
      res.status(201).json(created);
    } catch (e) { next(e); }
  });

  r.get('/projects/:name/sessions', async (req, res, next) => {
    try {
      const sessions = await listSessions(req.params.name);
      res.json(sessions);
    } catch (e) { next(e); }
  });

  // List worktrees that belong to a project. Returns the same metadata
  // shape that's stored in each worktree's .claude-orch-worktree.json,
  // augmented with the currently-running instance id (if any).
  r.get('/projects/:name/worktrees', async (req, res, next) => {
    try {
      const wts = await listWorktrees(req.params.name);
      const enriched = wts.map(w => ({
        ...w,
        instanceIds: instances ? instances.idsForWorktree(req.params.name, w.worktreeName) : [],
      }));
      res.json(enriched);
    } catch (e) { next(e); }
  });

  // Per-worktree session list — needed by the new-instance dialog when
  // the user is spawning into an existing worktree (the worktree has its
  // own ~/.claude/projects/<encoded>/ history, distinct from the parent).
  r.get('/projects/:name/worktrees/:wt/sessions', async (req, res, next) => {
    try {
      const wt = await getWorktree(req.params.name, req.params.wt);
      if (!wt) throw Object.assign(new Error('worktree not found'), { statusCode: 404 });
      res.json(await listSessionsForCwd(wt.worktreePath));
    } catch (e) { next(e); }
  });

  // Remove a worktree. Refuses if there's a live instance attached or
  // the worktree has uncommitted changes (unless ?force=1).
  r.delete('/projects/:name/worktrees/:wt', async (req, res, next) => {
    try {
      const force = req.query.force === '1' || req.query.force === 'true';
      if (instances) {
        const running = instances.idsForWorktree(req.params.name, req.params.wt)
          .map(id => instances.get(id))
          .filter(i => i && i.proc);
        if (running.length > 0 && !force) {
          throw Object.assign(new Error(
            `worktree has ${running.length} running instance(s) — kill them first or pass force=1`,
          ), { statusCode: 409 });
        }
        // With force, kill any attached instances before removing.
        if (force) {
          await Promise.all(running.map(i => i.kill({ graceMs: 300 }).catch(() => {})));
        }
      }
      await removeWorktree(req.params.name, req.params.wt, { force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  if (instances) {
    r.get('/instances', (req, res) => {
      res.json(instances.list());
    });

    r.post('/instances', async (req, res, next) => {
      try {
        const { project, resume, mode, effort, thinking, model, worktree } = req.body ?? {};
        const inst = await instances.create({ project, resume, mode, effort, thinking, model, worktree });
        res.status(201).json(inst.summary());
      } catch (e) { next(e); }
    });

    r.post('/instances/:id/respawn', async (req, res, next) => {
      try {
        const inst = await instances.respawn(req.params.id);
        res.json(inst.summary());
      } catch (e) { next(e); }
    });

    r.delete('/instances/:id', async (req, res, next) => {
      try {
        await instances.remove(req.params.id);
        res.json({ ok: true });
      } catch (e) { next(e); }
    });

    // Send the templated rebase-back prompt to a worktree-attached
    // instance. The agent runs `git rebase <baseBranch>` inside the
    // worktree, asks the user about conflicts if needed, and replies
    // REBASE_DONE so the user can click "Fast-forward parent" next.
    r.post('/instances/:id/rebase-prompt', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        if (!inst.worktree) throw Object.assign(new Error('instance is not attached to a worktree'), { statusCode: 400 });
        if (!inst.proc) throw Object.assign(new Error('instance is not running'), { statusCode: 409 });
        const prompt = buildRebasePrompt(inst.worktree);
        inst.prompt(prompt);
        res.json({ ok: true });
      } catch (e) { next(e); }
    });

    // Fast-forward the parent repo onto the worktree's branch. Returns
    // {ok:true, newSha} or {ok:false, reason} — callers render the
    // reason inline rather than treating non-ff as a server error.
    r.post('/instances/:id/fast-forward-parent', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        if (!inst.worktree) throw Object.assign(new Error('instance is not attached to a worktree'), { statusCode: 400 });
        const result = await fastForwardParent(inst.project, inst.worktree.worktreeName);
        res.json(result);
      } catch (e) { next(e); }
    });

    // PreToolUse http hook callback. The Claude Code CLI POSTs the hook
    // envelope here when a gated tool is about to run; we either
    // auto-allow (non-ask mode) or hold the response open and surface a
    // permission_request to the UI (ask mode) — the user's Allow/Deny
    // click eventually resolves the response. Response shape mirrors the
    // CLI's expected hookSpecificOutput JSON.
    r.post('/instances/:id/hook-callback', (req, res) => {
      const inst = instances.get(req.params.id);
      if (!inst) {
        // The CLI is the instance's own subprocess so this branch is
        // theoretical, but reply deterministically: 200 + deny body so
        // the CLI doesn't fall into its non-blocking-error path.
        res.status(200).json({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'orchestrator: instance not found',
          },
        });
        return;
      }
      inst.handleHookCallback(req.body ?? {}, res);
    });
  }

  r.use((err, req, res, _next) => {
    const status = err.statusCode ?? 500;
    res.status(status).json({ error: err.message ?? 'internal error' });
  });

  return r;
}
