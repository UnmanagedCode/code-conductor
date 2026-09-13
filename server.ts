import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { RealClaudeLauncher } from './src/claudeLauncher.ts';
import { buildRoutes } from './src/routes.ts';
import { buildMcpRouter } from './src/mcp/server.ts';
import { InstanceManager, sweepSessionTmpDirs } from './src/instances.ts';
import { sweepFuseSessions } from './src/systems/fuse/sweep.ts';
import { attachWsHub } from './src/wsHub.ts';
import { initCostTracking } from './src/costTracking.ts';
import { projectsRoot, orchStoreRoot, ensureSelfProjectWorkspace } from './src/projects.ts';
import { loadAllArchived } from './src/archivedSessions.ts';
import { runMigrations } from './migrations/index.mjs';
import { checkClaudeReadiness, formatReadiness } from './src/health.ts';
import { sweepPendingTempCleanup } from './src/tempCleanup.ts';
import { ensureConductProject } from './src/conduct.ts';
import { regenerateAllProjectConventions } from './src/projectClaudeMd.ts';
import { restoreFromResumeManifest } from './src/resumeRestart.ts';
import { createPluginHost, WORKSPACE_AUTO_ASSIGN } from './src/plugins/registry.ts';
import { createPluginLibrary } from './src/plugins/library.ts';
import { buildPluginProxy } from './src/plugins/proxy.ts';
import { setPluginConventionsProvider } from './src/projectConventions.ts';
import { setPluginConductorConventionsProvider } from './src/conductorConventions.ts';
import { setPluginRolesProvider, setLiveBackendsProvider } from './src/appSettings.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The shared mutable handle server.ts populates with the http server + wss once
// they exist (route handlers read them at request time). Structural match for
// routes.ts's ServerCtx.
interface ServerCtx {
  server?: http.Server | null;
  wss?: WebSocketServer | null;
}

export function createServer({ withInstances = true, claudeLauncher }: { withInstances?: boolean; claudeLauncher?: RealClaudeLauncher } = {}) {
  const app = express();
  const instances = withInstances ? new InstanceManager({ claudeLauncher }) : null;
  // Which backends live sessions are on — lets removeBackend refuse (409) rather
  // than delete a backend out from under a running/respawnable instance, whose next
  // relaunch would otherwise fall through to the real `claude`.
  setLiveBackendsProvider(instances ? () => instances.liveBackendUsage() : null);
  const pluginHost = withInstances ? createPluginHost({ instances }) : null;
  const pluginLibrary = withInstances ? createPluginLibrary({ pluginHost }) : null;
  // ── The provider wiring block ───────────────────────────────────────────
  //
  // FOUR module-global provider setters converge here, and this is the only src
  // site that calls any of them: `setPluginConventionsProvider`
  // (src/projectConventions.ts), `setPluginConductorConventionsProvider`
  // (src/conductorConventions.ts), `setPluginRolesProvider` and
  // `setLiveBackendsProvider` (both src/appSettings.ts). Measured, so a reader
  // deciding to add a FIFTH doesn't have to re-derive it:
  //
  //  - The two pairs use divergent reset idioms — the conventions pair takes
  //    `fn ?? default` with no runtime type guard; the appSettings pair takes
  //    `typeof fn === 'function'` plus a try/Array.isArray wrapper at the read.
  //  - They are process-wide ACROSS createServer() calls. A torn-down test
  //    server leaves its dead closure installed for the next importer; nothing
  //    resets them globally, only each test's own `finally`.
  //  - `instances.setClaudePluginDirsResolver` below is the instance-scoped
  //    shape and the target end state.
  //
  // Consolidating the four into one `setHostProviders({…})` object was
  // considered and DECLINED: it is the same process-wide module-global state
  // under a new name, at ~40 mechanical test call sites across 8 files, for no
  // measurable win. The fix worth making is instance-scoping, not renaming.
  //
  // Enabled plugins contribute project conventions (each optionally carrying a
  // one-time scaffold facet) and conductor conventions through these providers
  // (the host is a runtime singleton, wired after construction).
  // `conventions()` is grouped by scope; `project` and `conductor` are routed
  // today (`workspace` isn't accepted yet — see manifest.ts). Both providers
  // below now share ONE memoized scan (see registry.ts's `conventions()`), so
  // keeping them as two providers costs nothing.
  // pluginHost and instances are set together (both derive from withInstances);
  // the && guard is what lets TS see that here.
  if (pluginHost && instances) {
    setPluginConventionsProvider(async () => (await pluginHost.conventions()).project);
    setPluginConductorConventionsProvider(async () => (await pluginHost.conventions()).conductor);
    // Plugin-owned roles are live-derived from enabled plugins (sync — a role
    // binding is inline in the manifest, no fragment file). This lets spawn
    // resolution recognise <plugin-id>/<slug> roles and drops them on disable.
    setPluginRolesProvider(() => pluginHost.roles());
    // Enabled plugins' Claude Code plugin roots (skills et al.) → one
    // `--plugin-dir` per root at every claude launch. Resolved + validated
    // (a missing .claude-plugin/plugin.json warns + drops the flag) in
    // _doCreate and frozen on the Instance.
    instances.setClaudePluginDirsResolver(() => pluginHost.claudePluginDirs());
  }

  // serverCtx is a shared mutable handle so route handlers (POST
  // /admin/restart) can reach the http server + wss without those
  // existing at route-build time. Populated below once they do.
  const serverCtx: ServerCtx = {};
  app.use('/api', buildRoutes({ instances, serverCtx, pluginHost, pluginLibrary }));
  app.use('/mcp', buildMcpRouter({ instances, pluginHost }));
  const pluginProxy = buildPluginProxy({ pluginHost });
  app.use('/plugins', pluginProxy.handler);
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  // noServer + manual dispatch: the wsHub keeps /ws, plugin WebSockets pipe
  // through the reverse proxy, anything else is refused. (With noServer the
  // ws lib never touches `server`, so no error forwarding to guard against.)
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname: string | null = null;
    try { pathname = new URL(req.url ?? '', 'http://placeholder').pathname; }
    catch { socket.destroy(); return; }
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (pathname !== null && pathname.startsWith('/plugins/')) {
      pluginProxy.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
  if (instances) attachWsHub({ wss, instances });
  if (instances) initCostTracking(instances);
  serverCtx.server = server;
  serverCtx.wss = wss;

  return { app, server, instances, wss, pluginHost, pluginLibrary };
}

// `listen` with retry-on-EADDRINUSE — the self-respawn restart path
// (POST /api/admin/restart → src/restart.ts) exits the parent and
// immediately spawns a replacement. The kernel can take a moment to
// release the listening socket, so the child polls until it can bind.
// Other listen errors (EACCES etc.) propagate on the first attempt.
async function listenWithRetry(server: http.Server, port: number, host: string, { tries = 40, delayMs = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(port, host);
      });
      return;
    } catch (e) {
      if (errCode(e) !== 'EADDRINUSE' || i === tries - 1) throw e;
      process.stderr.write(`server: EADDRINUSE on port ${port}, retrying (${i + 1}/${tries})...\n`);
      await new Promise<void>(r => setTimeout(r, delayMs));
    }
  }
}

export async function start({ port = 8787, host = '127.0.0.1' } = {}) {
  // Apply any pending on-disk migrations before we accept traffic. Each
  // migration is idempotent and a no-op on an already-migrated workspace,
  // so this is fast in steady state. A migration that throws aborts boot.
  await runMigrations({ root: projectsRoot() });
  // Diagnostic: log the resolved store path + archived count at boot so a
  // path-divergence reset (a relaunch with a different PROJECTS_ROOT/cwd
  // reading a *different*, empty store) is visible in the logs. Non-fatal.
  try {
    const n = (await loadAllArchived()).size;
    const src = process.env.PROJECTS_ROOT ? 'PROJECTS_ROOT env' : 'default (repo parent)';
    console.log(`store: ${orchStoreRoot()} [${src}] — ${n} archived session(s)`);
  } catch { /* diagnostic only */ }
  // Belt-and-braces cleanup for temp sessions whose jsonl re-appeared after
  // the previous process exited (orphaned subagent writes etc.). The manifest
  // is written by scheduleRestart in src/restart.ts.
  try { sweepPendingTempCleanup({ log: console }); }
  catch (e) { console.warn('temp-cleanup sweep failed:', e); }
  // Reclaim session-tmp directories a previous process left behind. They hold
  // redirected sessions' backgrounded-command output, and a KILLED orchestrator
  // runs none of the teardown paths that normally reap them. No session is live
  // yet, so every entry is dead by construction.
  try { await sweepSessionTmpDirs([]); }
  catch (e) { console.warn('session-tmp sweep failed:', e); }
  // And every FUSE-union mount a previous process left behind, for the same
  // reason and by the same argument: an instance id is a fresh uuid per
  // process, so every record under systems/fuse/run/ is dead by construction.
  // This one is LOAD-BEARING rather than belt-and-braces — the restart path
  // exits ~50 ms after firing shutdown(), and neither synchronous shutdown path
  // can run the (async) mount teardown at all, so a mount and a root-owned
  // daemon would otherwise survive the orchestrator that created them.
  try { await sweepFuseSessions(); }
  catch (e) { console.warn('fuse sweep failed:', e); }
  const { server, instances, wss, pluginHost } = createServer();
  // The two app-owned regenerations below both run here, before listen: neither
  // needs the bound port. (What DOES gate on ordering is called out at
  // regenerateAllProjectConventions further down.)
  // Ensure the hidden `.conduct` project dir exists (the cwd of every conductor
  // session) and that its CLAUDE.md imports the role doc. The doc ITSELF is
  // composed fresh and written by the pre-spawn materializer, not here, so
  // there is nothing to regenerate at boot.
  // Strictly non-fatal — the Conduct-dialog-open path re-ensures anyway.
  try { await ensureConductProject(); }
  catch (e) { console.warn('.conduct project ensure failed:', e); }
  // ORDERING CONSTRAINT — this call, and only this call, must run AFTER
  // createServer(), which wires the plugin convention providers. It composes
  // the PROJECT catalog, the one that carries an `extraProvider`
  // (setPluginConventionsProvider). Unwired, that provider is a no-op stub
  // returning [], and the failure is SILENT, not a throw: ensureProjectConventionsMd
  // computes `missing` from the catalog and filters those slugs out BEFORE
  // compose, so every plugin-namespaced slug is demoted to the
  // "> Convention unavailable: `<slug>`." note and that demoted body is WRITTEN
  // into each project's in-tree CONVENTIONS.md. Nothing errors; the corruption
  // is only visible in the files. Pinned by tests/boot-plugin-conventions-order.test.mjs.
  //
  // Only the PROJECT part of each file is at risk: the workspace conventions
  // folded into the same document compose from the WORKSPACE catalog, which
  // passes no extraProvider at all (see src/workspaceConventions.ts), so a
  // plugin-namespaced slug can never enter it.
  //
  // Regenerate every project's in-tree CONVENTIONS.md — the composed workspace
  // conventions plus whatever that project's own marker selects — so existing
  // projects pick up improved convention text. An unresolvable slug drops out
  // of the body (named in a note) while the rest still refreshes. The file is
  // left as-is only when the catalog is degraded and a marker slug is
  // unresolvable (can't tell "gone" from "temporarily unreachable"). Strictly
  // non-fatal, same as the ensure above.
  try { await regenerateAllProjectConventions({ log: console }); }
  catch (e) { console.warn('project CONVENTIONS.md regenerate failed:', e); }
  // Seed the conductor's own project into CC-Dev, same placement plugins get
  // on discovery — the conductor itself isn't a plugin so it never hits that
  // path. Once-per-boot; no-op if already assigned or self can't be found.
  try { await ensureSelfProjectWorkspace(WORKSPACE_AUTO_ASSIGN); }
  catch (e) { console.warn('self workspace seed failed:', e); }
  await listenWithRetry(server, port, host);
  const addr = server.address();
  // listenWithRetry only resolves after the 'listening' event, so the bound
  // address is a TCP AddressInfo (never the string/pipe form). Guard fail-closed
  // anyway — this is a boot-fatal invariant, not something to limp past.
  if (!addr || typeof addr === 'string') throw new Error(`server.listen bound to unexpected address: ${addr}`);
  // Instance subprocesses need the actual bound port to construct the
  // PreToolUse http hook URL — feed it back into the manager now that
  // listen has resolved (port may have been auto-assigned via 0).
  if (instances) instances.setServerPort(addr.port);
  // Plugin children get CONDUCTOR_URL from the bound port; init() runs the
  // adopt-don't-drain reconciliation of children that survived a restart.
  // Fire-and-forget like the resume restore — boot must not gate on it.
  if (pluginHost) {
    pluginHost.setServerPort(addr.port);
    pluginHost.init().catch((e) => console.warn('plugin registry init failed:', errText(e)));
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
      .catch((e) => console.warn('resume-restart restore failed:', errText(e)));
  }
  // Readiness is informational only (a stderr warning banner). Run it AFTER
  // we're listening — never gate port availability on a `claude --version`
  // spawn that can be slow or CPU-starved under concurrent startup. (Awaiting
  // it here previously delayed listen() past test poll deadlines under load.)
  checkClaudeReadiness()
    .then((readiness) => process.stderr.write(formatReadiness(readiness) + '\n'))
    .catch((e) => process.stderr.write(`claude readiness check failed: ${errText(e)}\n`));
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

// The `code` on a thrown Node error (e.g. 'EADDRINUSE'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Same idiom as storeLock.ts et al.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// `e?.message || e` from the JS original, typed: an Error's message when
// truthy, else the thrown value itself (for a non-Error, or an empty
// message). Preserves the exact log text of the untyped boot path.
function errText(e: unknown): unknown {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    return m || e;
  }
  return e;
}
