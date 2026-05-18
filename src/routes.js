import express from 'express';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import {
  listProjects, createProject, listSessions, listSessionsForCwd,
  summarizeSessions, deleteProject, deleteSessionForCwd, getProject,
} from './projects.js';
import {
  isGitRepo, listWorktrees, removeWorktree, fastForwardParent,
  buildRebasePrompt, getWorktree, removeAllWorktreesForProject,
  attachmentsDir,
} from './worktrees.js';

const CONTENT_TYPE_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8',
};

export function buildRoutes({ instances } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  r.get('/projects', async (req, res, next) => {
    try {
      const projects = await listProjects();
      const enriched = await Promise.all(projects.map(async (p) => {
        const worktrees = await listWorktrees(p.name).catch(() => []);
        // Attach a lightweight session count + last-active mtime to
        // each worktree too, so the sidebar can decide whether to show
        // its "Sessions (N)" subnode without an extra fetch.
        const worktreesWithSessions = await Promise.all(worktrees.map(async (w) => ({
          ...w,
          sessions: await summarizeSessions(w.worktreePath).catch(() => ({ count: 0, lastMtime: 0 })),
        })));
        return {
          ...p,
          instanceIds: instances ? instances.idsForProject(p.name) : [],
          isGitRepo: await isGitRepo(p.path),
          worktrees: worktreesWithSessions,
          sessions: await summarizeSessions(p.path).catch(() => ({ count: 0, lastMtime: 0 })),
        };
      }));
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

  // Delete a project + all attached state. Cascade:
  //   1. validate the project exists,
  //   2. kill every running instance attached to it (including any
  //      inside worktrees of this project),
  //   3. remove every worktree (git worktree remove --force + branch
  //      delete + dir sweep for orphans),
  //   4. rm -rf the project directory itself.
  // Sessions under ~/.claude/projects/<encoded>/ are intentionally
  // left alone — they belong to the user's claude CLI history and
  // may still be referenced outside the orchestrator.
  r.delete('/projects/:name', async (req, res, next) => {
    try {
      const proj = await getProject(req.params.name);
      let killed = 0;
      if (instances) killed = await instances.removeAllForProject(proj.name);
      await removeAllWorktreesForProject(proj.name);
      await deleteProject(proj.name);
      res.json({ ok: true, project: proj.name, killedInstances: killed });
    } catch (e) { next(e); }
  });

  r.get('/projects/:name/sessions', async (req, res, next) => {
    try {
      const sessions = await listSessions(req.params.name);
      res.json(sessions);
    } catch (e) { next(e); }
  });

  // List worktrees that belong to a project. Returns the same metadata
  // shape that's stored in each worktree's .claude-orch-app/worktree.json,
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

  // Shared by both DELETE-session endpoints below. Refuses 409 when a
  // running instance has this sessionId — `claude --resume <sid>`
  // would otherwise be looking at a deleted jsonl mid-turn. ?force=1
  // kills attached instances first, then deletes.
  async function deleteSessionAtCwd({ cwd, sessionId, force }) {
    if (instances) {
      const running = instances.idsForSession(sessionId)
        .map(id => instances.get(id))
        .filter(i => i && i.proc);
      if (running.length > 0 && !force) {
        throw Object.assign(new Error(
          `session ${sessionId} is attached to a running instance — kill it first or pass force=1`,
        ), { statusCode: 409 });
      }
      if (force) {
        await Promise.all(running.map(i => instances.remove(i.id).catch(() => {})));
      }
    }
    const removed = await deleteSessionForCwd(cwd, sessionId);
    if (!removed) {
      throw Object.assign(new Error(`session ${sessionId} not found`), { statusCode: 404 });
    }
  }

  r.delete('/projects/:name/sessions/:sid', async (req, res, next) => {
    try {
      const proj = await getProject(req.params.name);
      const force = req.query.force === '1' || req.query.force === 'true';
      await deleteSessionAtCwd({ cwd: proj.path, sessionId: req.params.sid, force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete('/projects/:name/worktrees/:wt/sessions/:sid', async (req, res, next) => {
    try {
      const wt = await getWorktree(req.params.name, req.params.wt);
      if (!wt) throw Object.assign(new Error('worktree not found'), { statusCode: 404 });
      const force = req.query.force === '1' || req.query.force === 'true';
      await deleteSessionAtCwd({ cwd: wt.worktreePath, sessionId: req.params.sid, force });
      res.json({ ok: true });
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
        await inst.prompt(prompt);
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
    // Serve a previously-saved attachment from an instance's per-worktree
    // attachments dir. The frontend uses this to populate user-bubble
    // thumbnails on transcript replay (the bytes aren't echoed back via
    // the WS user_echo on a fresh page load because they were never
    // written to the session jsonl).
    r.get('/instances/:id/attachments/:filename', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        const raw = String(req.params.filename || '');
        // Path-traversal guard: reject anything that isn't a plain basename.
        if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw !== path.basename(raw)) {
          throw Object.assign(new Error('invalid attachment filename'), { statusCode: 400 });
        }
        const abs = path.join(attachmentsDir(inst.cwd), raw);
        let stat;
        try { stat = await fs.stat(abs); }
        catch (e) {
          if (e.code === 'ENOENT') throw Object.assign(new Error('attachment not found'), { statusCode: 404 });
          throw e;
        }
        if (!stat.isFile()) throw Object.assign(new Error('attachment not found'), { statusCode: 404 });
        const ext = (raw.split('.').pop() || '').toLowerCase();
        const ctype = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
        res.setHeader('Content-Type', ctype);
        res.setHeader('Content-Length', String(stat.size));
        // Cache aggressively — the filename includes a timestamp so it's
        // effectively immutable. Saves a re-fetch on every conversation
        // re-render.
        res.setHeader('Cache-Control', 'private, max-age=3600');
        createReadStream(abs).pipe(res);
      } catch (e) { next(e); }
    });

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
