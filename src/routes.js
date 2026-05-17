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
  }

  r.use((err, req, res, _next) => {
    const status = err.statusCode ?? 500;
    res.status(status).json({ error: err.message ?? 'internal error' });
  });

  return r;
}
