import express from 'express';

// REST surface for the plugin system — thin delegations to the registry
// (src/plugins/registry.js), which is the shared service layer for REST,
// the reverse proxy and MCP forwarding. Mounted from src/routes.js at
// /plugins (⇒ /api/plugins), inheriting its JSON body parser and its
// trailing error middleware (err.statusCode → JSON).
export function buildPluginApi({ pluginHost, pluginLibrary } = {}) {
  const r = express.Router();

  r.use((req, res, next) => {
    if (!pluginHost) return res.status(404).json({ error: 'plugins are not available' });
    next();
  });

  // Plugin Library — installable catalog (git repo URLs) + clone-to-install.
  // Constructed alongside pluginHost (same withInstances gate in server.js),
  // so the guard above already covers these too.
  r.get('/library', async (req, res, next) => {
    try { res.json(await pluginLibrary.list()); } catch (e) { next(e); }
  });

  r.post('/library/:id/install', async (req, res, next) => {
    try { res.json(await pluginLibrary.install(req.params.id)); } catch (e) { next(e); }
  });

  r.post('/library/:id/update', async (req, res, next) => {
    try { res.json(await pluginLibrary.update(req.params.id)); } catch (e) { next(e); }
  });

  r.get('/', async (req, res, next) => {
    try { res.json(await pluginHost.list()); } catch (e) { next(e); }
  });

  r.post('/rescan', async (req, res, next) => {
    try { res.json(await pluginHost.rescan()); } catch (e) { next(e); }
  });

  r.post('/:id/enable', async (req, res, next) => {
    try { res.json(await pluginHost.enable(req.params.id)); } catch (e) { next(e); }
  });

  r.post('/:id/disable', async (req, res, next) => {
    try { res.json(await pluginHost.disable(req.params.id)); } catch (e) { next(e); }
  });

  r.post('/:id/start', async (req, res, next) => {
    try { res.json(await pluginHost.start(req.params.id)); } catch (e) { next(e); }
  });

  r.post('/:id/stop', async (req, res, next) => {
    try { res.json(await pluginHost.stop(req.params.id)); } catch (e) { next(e); }
  });

  // Live probe: also flips a silently-dead child to crashed.
  r.get('/:id/status', async (req, res, next) => {
    try { res.json(await pluginHost.status(req.params.id)); } catch (e) { next(e); }
  });

  // {type:'main'} | {type:'worktree', name} — restarts the child if running.
  r.post('/:id/version', async (req, res, next) => {
    try { res.json(await pluginHost.setActiveVersion(req.params.id, req.body ?? {})); } catch (e) { next(e); }
  });

  return r;
}
