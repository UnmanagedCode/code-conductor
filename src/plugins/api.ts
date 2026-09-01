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
  // Non-ENOENT load failures from the last init pass — see registry.ts loadJson.
  notices(): Array<{ file: string; reason: string; backup: string | null }>;
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

// Regenerating project CONVENTIONS.md is plumbing on top of a mutation that
// already succeeded and is already persisted — it must never turn a successful
// rescan/enable/disable/restart/version/install/update response into an error.
// A referencing project's other, resolvable conventions still refresh even
// when this plugin's slug goes unresolvable; `{ log: console }` surfaces the
// server log for every case where a write is declined instead (nothing
// resolves at all; every slug resolves but none carries a body; or — exactly
// how e.g. a disable route can reach this — the catalog is degraded while a
// slug is unresolvable) — see docs/plugins.md's known limitations.
async function refreshProjectConventions(): Promise<void> {
  try { await regenerateAllProjectConventions({ log: console }); }
  catch (e) { console.warn('plugins: project CONVENTIONS.md regenerate failed:', e); }
}

export function buildPluginApi({ pluginHost, pluginLibrary }: { pluginHost?: PluginHostApiLike | null; pluginLibrary?: PluginLibraryApiLike | null } = {}): express.Router {
  const r = express.Router();

  r.use((req, res, next) => {
    if (!pluginHost) return res.status(404).json({ error: 'plugins are not available' });
    next();
  });
  // Every route below runs only after the guard above has passed, so the host
  // (and the library, which server.ts constructs alongside it) is non-null
  // there. `!` captures that; a null library would have crashed the original
  // routes identically (the guard never checked it).
  const host = pluginHost!;
  const lib = pluginLibrary!;

  // Plugin Library — installable catalog (git repo URLs) + clone-to-install.
  // Constructed alongside pluginHost (same withInstances gate in server.ts),
  // so the guard above already covers these too.
  r.get('/library', async (req, res, next) => {
    try { res.json(await lib.list()); } catch (e) { next(e); }
  });

  r.post('/library/:id/install', (req, res, next) => streamLibraryAction(res, next, async (onChunk, onValidated) => {
    const result = await lib.install(req.params.id, { onChunk, onValidated });
    await refreshProjectConventions();
    return result;
  }));

  r.post('/library/:id/update', (req, res, next) => streamLibraryAction(res, next, async (onChunk, onValidated) => {
    const result = await lib.update(req.params.id, { onChunk, onValidated });
    await refreshProjectConventions();
    return result;
  }));

  // `notices` carries any non-ENOENT registry.json/runtime.json load failure from
  // the init this call triggers — read AFTER awaiting list(), which is what runs
  // ensureInit and therefore what populates them.
  r.get('/', async (req, res, next) => {
    try {
      const rows = await host.list();
      res.json({ rows, notices: host.notices() });
    } catch (e) { next(e); }
  });

  // Every mutating route below fans out to refreshProjectConventions() after
  // the underlying host/library mutation succeeds — rescan/enable/disable/
  // restart/version/install/update can all change which project conventions
  // the catalog offers (a plugin contributes conventions via
  // setPluginConventionsProvider) or which fragment bodies are cached
  // (rescan/restart/version also drop the host's fragment-body cache — see
  // invalidate() in plugins/contributions.ts, which the registry calls as
  // contributions.invalidate(); it is not on the host's public surface).
  // A disable makes the plugin's
  // slugs unresolvable: referencing projects still refresh their other,
  // resolvable conventions, with the plugin's slugs named in a note (never
  // blanked); an enable re-resolves them ⇒ full refresh.
  r.post('/rescan', async (req, res, next) => {
    try {
      const result = await host.rescan();
      await refreshProjectConventions();
      res.json(result);
    } catch (e) { next(e); }
  });

  r.post('/:id/enable', async (req, res, next) => {
    try {
      const result = await host.enable(req.params.id);
      await refreshProjectConventions();
      res.json(result);
    } catch (e) { next(e); }
  });

  r.post('/:id/disable', async (req, res, next) => {
    try {
      const result = await host.disable(req.params.id);
      await refreshProjectConventions();
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
    try {
      const result = await host.restart(req.params.id);
      await refreshProjectConventions();
      res.json(result);
    } catch (e) { next(e); }
  });

  // Live probe: also flips a silently-dead child to crashed.
  r.get('/:id/status', async (req, res, next) => {
    try { res.json(await host.status(req.params.id)); } catch (e) { next(e); }
  });

  // {type:'main'} | {type:'worktree', name} — restarts the child if running.
  r.post('/:id/version', async (req, res, next) => {
    try {
      const result = await host.setActiveVersion(req.params.id, req.body ?? {});
      await refreshProjectConventions();
      res.json(result);
    } catch (e) { next(e); }
  });

  return r;
}
