import express from 'express';
import { projectsBySystem } from '../projects.ts';
import { enumerateSystemRemotes } from '../systems/remoteEnumeration.ts';
import { getSystems, addSystem, updateSystem, removeSystem } from '../appSettings.ts';
import { jsonBody } from './shared.ts';

export function mountSystems(r: express.Router): void {
  // ── The system registry (Settings → Systems) ───────────────────────────
  // A row declares that an execution environment exists, what to call it, and
  // — when it carries a `launch` — the provider command cc runs to reach it.
  // Saving one with a command CONNECTS to it first: an unreachable system is
  // refused here (502, quoting the provider) rather than saved and discovered
  // broken by the first project put on it.
  //
  // Each row carries the projects whose record NAMES it, so the still-referenced
  // refusal below is visible before it is hit. `local` always carries none: a
  // local project has no `system` field to name it with, which is the same
  // absence-means-local rule the resolver reads.
  async function systemsState() {
    const byId = await projectsBySystem();
    return { systems: getSystems().map(s => ({ ...s, projects: byId[s.id] ?? [] })) };
  }

  r.get('/settings/systems', async (_req, res, next) => {
    try { res.json(await systemsState()); } catch (e) { next(e); }
  });

  r.post('/settings/systems', async (req, res, next) => {
    try {
      const { id, label, launch, worktreesDir } = jsonBody(req);
      const rec = await addSystem({ id, label, launch, worktreesDir });
      res.status(201).json({ ...(await systemsState()), added: rec });
    } catch (e) { next(e); }
  });

  r.patch('/settings/systems/:id', async (req, res, next) => {
    try {
      const { label, launch, worktreesDir } = jsonBody(req);
      const rec = await updateSystem(req.params.id, { label, launch, worktreesDir });
      if (!rec) return res.status(404).json({ error: 'system not found' });
      res.json({ ...(await systemsState()), updated: rec });
    } catch (e) { next(e); }
  });

  // Removal NEVER cascades: a system a project record still names is refused
  // with 409 naming those projects (removeSystem throws it), the managed row
  // with 400, an unknown id with 404.
  r.delete('/settings/systems/:id', async (req, res, next) => {
    try {
      const ok = await removeSystem(req.params.id);
      if (!ok) return res.status(404).json({ error: 'system not found' });
      res.json(await systemsState());
    } catch (e) { next(e); }
  });

  // Which remoteIds a System's provider is configured for — the MCP tool
  // `enumerate_remotes` answers from the same caller. ALWAYS 200: every
  // per-System outcome, an unregistered id included, is a state in the body,
  // so no client can read a failure as an empty list.
  r.get('/systems/:id/remotes', async (req, res, next) => {
    try { res.json(await enumerateSystemRemotes(req.params.id)); } catch (e) { next(e); }
  });
}
