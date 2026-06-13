import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { buildRoutes } from './src/routes.js';
import { buildMcpRouter } from './src/mcp/server.js';
import { InstanceManager } from './src/instances.js';
import { attachWsHub } from './src/wsHub.js';
import { initCostTracking } from './src/costTracking.js';
import { projectsRoot } from './src/projects.js';
import { runMigrations } from './migrations/index.mjs';
import { checkClaudeReadiness, formatReadiness } from './src/health.js';
import { sweepPendingTempCleanup } from './src/tempCleanup.js';
import { reconcile as reconcileRootClaudeMd } from './src/rootClaudeMd.js';
import { restoreFromResumeManifest } from './src/resumeRestart.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ withInstances = true } = {}) {
  const app = express();
  const instances = withInstances ? new InstanceManager() : null;

  // serverCtx is a shared mutable handle so route handlers (POST
  // /admin/restart) can reach the http server + wss without those
  // existing at route-build time. Populated below once they do.
  const serverCtx = {};
  app.use('/api', buildRoutes({ instances, serverCtx }));
  app.use('/mcp', buildMcpRouter({ instances }));
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  if (instances) attachWsHub({ wss, instances });
  if (instances) initCostTracking(instances);
  serverCtx.server = server;
  serverCtx.wss = wss;

  return { app, server, instances, wss };
}

// `listen` with retry-on-EADDRINUSE — the self-respawn restart path
// (POST /api/admin/restart → src/restart.js) exits the parent and
// immediately spawns a replacement. The kernel can take a moment to
// release the listening socket, so the child polls until it can bind.
// Other listen errors (EACCES etc.) propagate on the first attempt.
async function listenWithRetry(server, port, host, { tries = 40, delayMs = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(port, host);
      });
      return;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || i === tries - 1) throw e;
      process.stderr.write(`server: EADDRINUSE on port ${port}, retrying (${i + 1}/${tries})...\n`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

export async function start({ port = 8787, host = '127.0.0.1' } = {}) {
  // Apply any pending on-disk migrations before we accept traffic. Each
  // migration is idempotent and a no-op on an already-migrated workspace,
  // so this is fast in steady state. A migration that throws aborts boot.
  await runMigrations({ root: projectsRoot() });
  // Belt-and-braces cleanup for temp sessions whose jsonl re-appeared after
  // the previous process exited (orphaned subagent writes etc.). The manifest
  // is written by scheduleRestart in src/restart.js.
  try { sweepPendingTempCleanup({ log: console }); }
  catch (e) { console.warn('temp-cleanup sweep failed:', e); }
  // Mirror the bundled canonical workspace-conventions into
  // <PROJECTS_ROOT>/CLAUDE.md (the file every project imports via
  // `@../CLAUDE.md`). Strictly non-fatal: a reconcile failure must never
  // abort boot — unlike a migration, this is a convenience sync.
  try { await reconcileRootClaudeMd({ log: console }); }
  catch (e) { console.warn('root CLAUDE.md reconcile failed:', e); }
  const { server, instances, wss } = createServer();
  // ws 8.20.1 registers `server.on('error', wss.emit.bind(wss, 'error'))` during
  // WebSocketServer construction, before listenWithRetry's own once('error') is
  // registered. On EADDRINUSE that forwarding fires first; with no wss 'error'
  // listener Node throws an unhandled event and kills the process before the retry
  // loop can run. Guard the wss during the retry window only, then remove it.
  const _wssErrGuard = () => {};
  wss.on('error', _wssErrGuard);
  await listenWithRetry(server, port, host);
  wss.off('error', _wssErrGuard);
  const addr = server.address();
  // Instance subprocesses need the actual bound port to construct the
  // PreToolUse http hook URL — feed it back into the manager now that
  // listen has resolved (port may have been auto-assigned via 0).
  if (instances) instances.setServerPort(addr.port);
  // Resurrect sessions carried over by a "Resume after restart". Fire-and-forget
  // (like the readiness check) so boot returns fast and the reloaded UI can
  // connect while sessions re-spawn + get their resume notifications, staggered.
  // No-op when no resume manifest is present. Needs the bound port (create()
  // builds the per-instance hook/MCP URLs from it), so it runs after setServerPort.
  if (instances) {
    restoreFromResumeManifest({ instances, log: console })
      .catch((e) => console.warn('resume-restart restore failed:', e?.message || e));
  }
  // Readiness is informational only (a stderr warning banner). Run it AFTER
  // we're listening — never gate port availability on a `claude --version`
  // spawn that can be slow or CPU-starved under concurrent startup. (Awaiting
  // it here previously delayed listen() past test poll deadlines under load.)
  checkClaudeReadiness()
    .then((readiness) => process.stderr.write(formatReadiness(readiness) + '\n'))
    .catch((e) => process.stderr.write(`claude readiness check failed: ${e?.message || e}\n`));
  return { server, instances, wss, port: addr.port, host: addr.address };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.title = 'code-conductor';
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  start({ port, host }).then(({ port, host }) => {
    console.log(`code-conductor listening on http://${host}:${port}`);
  }).catch(e => {
    console.error('failed to start:', e);
    process.exit(1);
  });
}
