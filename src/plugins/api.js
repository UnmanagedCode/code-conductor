import express from 'express';

// REST surface for the plugin system — thin delegations to the registry
// (src/plugins/registry.js), which is the shared service layer for REST,
// the reverse proxy and MCP forwarding. Mounted from src/routes.js at
// /plugins (⇒ /api/plugins), inheriting its JSON body parser and its
// trailing error middleware (err.statusCode → JSON).

// Runs an install/update call that reports progress via onChunk and flips
// into streaming mode via onValidated (see pluginLibrary.install/update).
// Before onValidated fires, a rejection is a normal thrown error — routed to
// the shared trailing error middleware via `next`, same as every other route
// here (preserves today's 404/409/400 status codes for validation failures).
// After onValidated fires, response bytes are already committed as 200
// NDJSON, so both success and failure resolve into a single terminal
// {type:'result', ...} line instead of an HTTP status.
function streamLibraryAction(res, next, run) {
  let streaming = false;
  const write = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
  const onValidated = () => {
    streaming = true;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
  };
  const onChunk = (phase, text) => write({ type: 'chunk', phase, text });
  return run(onChunk, onValidated).then(
    (result) => {
      if (streaming) { write({ type: 'result', ok: true, result }); res.end(); }
      else res.json(result);
    },
    (e) => {
      if (streaming) { write({ type: 'result', ok: false, error: e.message, tail: e.tail }); res.end(); }
      else next(e);
    },
  );
}

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

  r.post('/library/:id/install', (req, res, next) => streamLibraryAction(res, next, (onChunk, onValidated) => pluginLibrary.install(req.params.id, { onChunk, onValidated })));

  r.post('/library/:id/update', (req, res, next) => streamLibraryAction(res, next, (onChunk, onValidated) => pluginLibrary.update(req.params.id, { onChunk, onValidated })));

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

  // Stop + start the running child in place — the pick-up path for a plugin
  // whose active checkout moved past the sha it was started at.
  r.post('/:id/restart', async (req, res, next) => {
    try { res.json(await pluginHost.restart(req.params.id)); } catch (e) { next(e); }
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
