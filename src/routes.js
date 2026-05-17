import express from 'express';
import { listProjects, createProject, listSessions } from './projects.js';

export function buildRoutes({ instances } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  r.get('/projects', async (req, res, next) => {
    try {
      const projects = await listProjects();
      const withInstances = projects.map(p => ({
        ...p,
        instanceIds: instances ? instances.idsForProject(p.name) : [],
      }));
      res.json(withInstances);
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

  if (instances) {
    r.get('/instances', (req, res) => {
      res.json(instances.list());
    });

    r.post('/instances', async (req, res, next) => {
      try {
        const { project, resume, mode, effort, thinking, model } = req.body ?? {};
        const inst = await instances.create({ project, resume, mode, effort, thinking, model });
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
