import express from 'express';
import { regenerateAllProjectConventions } from '../projectClaudeMd.ts';

// REST surface for the plugin system — thin delegations to the registry
// (src/plugins/registry.ts), which is the shared service layer for REST,
// the reverse proxy and MCP forwarding. Mounted from src/routes.ts at
// /plugins (⇒ /api/plugins), inheriting its JSON body parser and its
// trailing error middleware (err.statusCode → JSON).

// The plugin-host / plugin-library surfaces these routes delegate to. Typed as
// the read subset (registry.PluginRow and library's return types are internal
// to those modules — the actual return values flow through res.json untouched).
export interface PluginHostApiLike {
  list(): Promise<unknown>;
  rescan(): Promise<unknown>;
  enable(id: string): Promise<unknown>;
  disable(id: string): Promise<unknown>;
  start(id: string): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  restart(id: string): Promise<unknown>;
  status(id: string): Promise<unknown>;
  setActiveVersion(id: string, input: unknown): Promise<unknown>;
}

export interface PluginLibraryApiLike {
  list(): Promise<unknown>;
  install(id: string, opts: { onChunk: (phase: string, text: string) => void; onValidated: () => void }): Promise<unknown>;
  update(id: string, opts: { onChunk: (phase: string, text: string) => void; onValidated: () => void }): Promise<unknown>;
}

// Runs an install/update call that reports progress via onChunk and flips
// into streaming mode via onValidated (see pluginLibrary.install/update).
// Before onValidated fires, a rejection is a normal thrown error — routed to
// the shared trailing error middleware via `next`, same as every other route
// here (preserves today's 404/409/400 status codes for validation failures).
// After onValidated fires, response bytes are already committed as 200
// NDJSON, so both success and failure resolve into a single terminal
// {type:'result', ...} line instead of an HTTP status.
function streamLibraryAction(res: express.Response, next: express.NextFunction, run: (onChunk: (phase: string, text: string) => void, onValidated: () => void) => Promise<unknown>): void {
  let streaming = false;
  const write = (obj: unknown) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
  const onValidated = () => {
    streaming = true;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
  };
  const onChunk = (phase: string, text: string) => write({ type: 'chunk', phase, text });
  run(onChunk, onValidated).then(
    (result) => {
      if (streaming) { write({ type: 'result', ok: true, result }); res.end(); }
      else res.json(result);
    },
    (e) => {
      const err = e as { message?: unknown; tail?: unknown };
      if (streaming) { write({ type: 'result', ok: false, error: err.message, tail: err.tail }); res.end(); }
      else next(e);
    },
  );
}

export function buildPluginApi({ pluginHost, pluginLibrary }: { pluginHost?: PluginHostApiLike | null; pluginLibrary?: PluginLibraryApiLike | null } = {}): express.Router {
  const r = express.Router();

  r.use((req, res, next) => {
    if (!pluginHost) return res.status(404).json({ error: 'plugins are not available' });
    next();
  });
  // Every route below runs only after the guard above has passed, so the host
  // (and the library, which server.js constructs alongside it) is non-null
  // there. `!` captures that; a null library would have crashed the original
  // routes identically (the guard never checked it).
  const host = pluginHost!;
  const lib = pluginLibrary!;

  // Plugin Library — installable catalog (git repo URLs) + clone-to-install.
  // Constructed alongside pluginHost (same withInstances gate in server.js),
  // so the guard above already covers these too.
  r.get('/library', async (req, res, next) => {
    try { res.json(await lib.list()); } catch (e) { next(e); }
  });

  r.post('/library/:id/install', (req, res, next) => streamLibraryAction(res, next, (onChunk, onValidated) => lib.install(req.params.id, { onChunk, onValidated })));

  r.post('/library/:id/update', (req, res, next) => streamLibraryAction(res, next, (onChunk, onValidated) => lib.update(req.params.id, { onChunk, onValidated })));

  r.get('/', async (req, res, next) => {
    try { res.json(await host.list()); } catch (e) { next(e); }
  });

  r.post('/rescan', async (req, res, next) => {
    try { res.json(await host.rescan()); } catch (e) { next(e); }
  });

  // Enable/disable can change which project conventions the catalog offers
  // (a plugin contributes conventions via setPluginConventionsProvider), so
  // fan out to refresh every referencing project's CONVENTIONS.md — exactly as
  // the project custom-convention CRUD routes do in src/routes.ts. No-op-safe:
  // a disable makes the plugin's slugs unresolvable ⇒ referencing projects are
  // skipped (frozen), never blanked; an enable re-resolves them ⇒ refresh.
  r.post('/:id/enable', async (req, res, next) => {
    try {
      const result = await host.enable(req.params.id);
      await regenerateAllProjectConventions();
      res.json(result);
    } catch (e) { next(e); }
  });

  r.post('/:id/disable', async (req, res, next) => {
    try {
      const result = await host.disable(req.params.id);
      await regenerateAllProjectConventions();
      res.json(result);
    } catch (e) { next(e); }
  });

  r.post('/:id/start', async (req, res, next) => {
    try { res.json(await host.start(req.params.id)); } catch (e) { next(e); }
  });

  r.post('/:id/stop', async (req, res, next) => {
    try { res.json(await host.stop(req.params.id)); } catch (e) { next(e); }
  });

  // Stop + start the running child in place — the pick-up path for a plugin
  // whose active checkout moved past the sha it was started at.
  r.post('/:id/restart', async (req, res, next) => {
    try { res.json(await host.restart(req.params.id)); } catch (e) { next(e); }
  });

  // Live probe: also flips a silently-dead child to crashed.
  r.get('/:id/status', async (req, res, next) => {
    try { res.json(await host.status(req.params.id)); } catch (e) { next(e); }
  });

  // {type:'main'} | {type:'worktree', name} — restarts the child if running.
  r.post('/:id/version', async (req, res, next) => {
    try { res.json(await host.setActiveVersion(req.params.id, req.body ?? {})); } catch (e) { next(e); }
  });

  return r;
}
