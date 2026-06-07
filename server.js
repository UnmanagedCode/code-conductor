import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { buildRoutes } from './src/routes.js';
import { buildMcpRouter } from './src/mcp/server.js';
import { InstanceManager } from './src/instances.js';
import { attachWsHub } from './src/wsHub.js';
import { projectsRoot } from './src/projects.js';
import { runMigrations } from './migrations/index.mjs';
import { checkClaudeReadiness, formatReadiness } from './src/health.js';
import { sweepPendingTempCleanup } from './src/tempCleanup.js';
import { reconcile as reconcileRootClaudeMd } from './src/rootClaudeMd.js';

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
  const readiness = await checkClaudeReadiness();
  process.stderr.write(formatReadiness(readiness) + '\n');
  const { server, instances, wss } = createServer();
  await listenWithRetry(server, port, host);
  const addr = server.address();
  // Instance subprocesses need the actual bound port to construct the
  // PreToolUse http hook URL — feed it back into the manager now that
  // listen has resolved (port may have been auto-assigned via 0).
  if (instances) instances.setServerPort(addr.port);
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
