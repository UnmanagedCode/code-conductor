import express from 'express';
import { addWorkspace, removeWorkspace, renameWorkspace, summarizeWorkspaces } from '../projects.ts';
import { jsonBody } from './shared.ts';

export function mountWorkspaces(r: express.Router): void {
  // ── Workspace registry endpoints ────────────────────────────────────
  // Workspaces persist independently of membership: an empty workspace
  // stays visible in the sidebar. The registry is the union source.

  r.get('/workspaces', async (_req, res, next) => {
    try {
      res.json(await summarizeWorkspaces());
    } catch (e) { next(e); }
  });

  r.post('/workspaces', async (req, res, next) => {
    try {
      const name = jsonBody(req).name as string;
      const result = await addWorkspace(name);
      res.status(result.added ? 201 : 200).json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  r.delete('/workspaces/:name', async (req, res, next) => {
    try {
      const result = await removeWorkspace(req.params.name);
      res.json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  r.put('/workspaces/:name', async (req, res, next) => {
    try {
      const newName = jsonBody(req).name as string;
      const result = await renameWorkspace(req.params.name, newName);
      res.json({ ok: true, ...result });
    } catch (e) { next(e); }
  });
}
