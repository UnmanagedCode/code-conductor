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
import { createPluginHost } from './src/plugins/registry.js';
import { buildPluginProxy } from './src/plugins/proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ withInstances = true } = {}) {
  const app = express();
  const instances = withInstances ? new InstanceManager() : null;
  const pluginHost = withInstances ? createPluginHost({ instances }) : null;

  // serverCtx is a shared mutable handle so route handlers (POST
  // /admin/restart) can reach the http server + wss without those
  // existing at route-build time. Populated below once they do.
  const serverCtx = {};
  app.use('/api', buildRoutes({ instances, serverCtx }));
  app.use('/mcp', buildMcpRouter({ instances }));
  const pluginProxy = buildPluginProxy({ pluginHost });
  app.use('/plugins', pluginProxy.handler);
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  // noServer + manual dispatch: the wsHub keeps /ws, plugin WebSockets pipe
  // through the reverse proxy, anything else is refused. (With noServer the
  // ws lib never touches `server`, so no error forwarding to guard against.)
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://placeholder').pathname; }
    catch { socket.destroy(); return; }
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (pathname.startsWith('/plugins/')) {
      pluginProxy.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
  if (instances) attachWsHub({ wss, instances });
  if (instances) initCostTracking(instances);
  serverCtx.server = server;
  serverCtx.wss = wss;

  return { app, server, instances, wss, pluginHost };
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
  const { server, instances, wss, pluginHost } = createServer();
  await listenWithRetry(server, port, host);
  const addr = server.address();
  // Instance subprocesses need the actual bound port to construct the
  // PreToolUse http hook URL — feed it back into the manager now that
  // listen has resolved (port may have been auto-assigned via 0).
  if (instances) instances.setServerPort(addr.port);
  // Plugin children get CONDUCTOR_URL from the bound port; init() runs the
  // adopt-don't-drain reconciliation of children that survived a restart.
  // Fire-and-forget like the resume restore — boot must not gate on it.
  if (pluginHost) {
    pluginHost.setServerPort(addr.port);
    pluginHost.init().catch((e) => console.warn('plugin registry init failed:', e?.message || e));
  }
  // Start the server-side usage poller (overage auto-stop's second trigger
  // source). Its timer lifecycle tracks the server's, like the bound port; the
  // monitor itself stays unit-testable without a server (tests call _tick()
  // directly). Stopped in both manager shutdown paths.
  if (instances) instances._usageMonitor.start();
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
  return { server, instances, wss, pluginHost, port: addr.port, host: addr.address };
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
