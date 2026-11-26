// The /api REST router. buildRoutes only composes: the router-level middleware
// below and the per-area mounts in src/routes/ register on ONE router, in this
// order. Express dispatches to the first matching layer, so the order is the
// contract (literal routes ahead of their param twins, the cache header and the
// /exec parser ahead of the 1mb parser, the capability gates ahead of the routes
// they cover, the error handler last); tests/route-table.test.mjs pins it and
// scripts/route-table.mjs prints the resulting table.
import express from 'express';
import { buildPluginApi } from './plugins/api.ts';
import type { PluginHostApiLike, PluginLibraryApiLike } from './plugins/api.ts';
import { buildPlaybookApi } from './playbookApi.ts';
import type { PendingContinue } from './pendingContinue.ts';
import type { RunningRecorder } from './runningRecord.ts';
import type { ClaudeAuthStatus } from './claudeAuthStatus.ts';
import type { ClaudeLoginFlow } from './claudeLogin.ts';
import { requireCapability } from './capabilities.ts';
import { hostPlatform, type PlatformCapabilities } from './platform/index.ts';
import type { InstanceManagerLike } from './instanceTypes.ts';
import type { PlaybookGate } from './mcp/playbookGate.ts';
import { mountExec } from './routes/exec.ts';
import { mountAdmin } from './routes/admin.ts';
import type { ServerRestartState } from '../shared/wireRows.ts';
import { mountSpawnPrefs, mountModels, mountModelCatalog } from './routes/models.ts';
import { mountProjects } from './routes/projects.ts';
import { mountWorkspaces } from './routes/workspaces.ts';
import { mountProjectSessions } from './routes/projectSessions.ts';
import { mountWorktrees } from './routes/worktrees.ts';
import { mountSessions } from './routes/sessions.ts';
import { mountInstances } from './routes/instances.ts';
import { mountInstanceHooks } from './routes/instanceHooks.ts';
import { mountTranscribe, mountTts } from './routes/voice.ts';
import { mountSystems } from './routes/systems.ts';
import { mountWorkspaceConventions, mountProjectConventions, mountConductorConventions } from './routes/conventions.ts';
import { mountAccount } from './routes/account.ts';
import { mountErrorHandler } from './routes/errors.ts';
import type { RelaunchOptions } from './routes/admin.ts';
import type { ServerCtx } from './routes/shared.ts';
import type { HealthFocus } from '../shared/focus.ts';
import type { UiMode } from '../shared/uiMode.ts';

export function buildRoutes({ instances, serverCtx, relaunch = { flags: { buildWeb: true, syncDeps: true } }, recorder = null, pending = null, pluginHost, pluginLibrary, playbookGate, capabilities = hostPlatform.capabilities, claudeLogin, claudeAuthStatus, restartStatus, uiMode = 'full', focus = null }:
  {
    // `--ui` (shared/uiMode.ts): GET /health's top-level `uiMode`.
    uiMode?: UiMode;
    // A headless-family server's focused session, advertised on GET /health.
    focus?: HealthFocus | null;
    instances?: InstanceManagerLike | null;
    serverCtx?: ServerCtx | null;
    relaunch?: RelaunchOptions;
    // The running recorder, paused for a restart's or shutdown's drain.
    recorder?: RunningRecorder | null;
    // The resume banner's notices (/resume-notices).
    pending?: PendingContinue | null;
    pluginHost?: PluginHostApiLike | null;
    pluginLibrary?: PluginLibraryApiLike | null;
    playbookGate?: PlaybookGate | null;
    capabilities?: PlatformCapabilities;
    claudeLogin?: ClaudeLoginFlow | null;
    claudeAuthStatus?: (() => Promise<ClaudeAuthStatus>) | null;
    // GET /settings/self-update's `restart` (src/restartStatus.ts).
    restartStatus?: (() => Promise<ServerRestartState>) | null;
  } = {}): express.Router {
  const r = express.Router();
  // Every /api body is live state: no cache entry for concurrent identical GETs
  // to queue on. First, so even a body-parse refusal carries it; a route that
  // sets its own Cache-Control later overrides this.
  r.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Plugin-facing command execution (src/hostExec.ts). Mounted AHEAD of the
  // router-wide 1mb parser, which would otherwise refuse a large stdin 413
  // first, and outside the remoteSystems gate: `local` works on every platform,
  // and hostExec refuses a non-local system itself.
  mountExec(r, { capabilities });
  r.use(express.json({ limit: '1mb' }));
  // Features the host platform turns off are refused here, before their handlers.
  r.use(['/settings/systems', '/systems', '/projects/:name/remote'], requireCapability(capabilities, 'remoteSystems'));
  r.use(['/transcribe', '/tts', '/settings/transcribe', '/settings/tts'], requireCapability(capabilities, 'voice'));
  // Plugin management API (GET /, rescan, enable/disable/start/stop/status/
  // version, library list/install) — delegates to the registry/library,
  // errors bubble to the middleware at the bottom of this router.
  r.use('/plugins', buildPluginApi({ pluginHost, pluginLibrary }));
  // Playbook read + validate API (list, describe, dry-run validate) — see
  // src/playbookApi.ts; there is no write route.
  r.use('/playbooks', buildPlaybookApi({ playbookGate }));

  mountAdmin(r, { instances, serverCtx, relaunch, recorder, pending, capabilities, restartStatus, uiMode, focus });
  mountSpawnPrefs(r);
  mountProjects(r, { instances, capabilities });
  mountWorkspaces(r);
  mountProjectSessions(r, { instances });
  mountWorktrees(r, { instances });
  mountSessions(r, { instances, serverCtx });
  if (instances) {
    mountInstances(r, { instances, playbookGate });
    mountInstanceHooks(r, { instances, playbookGate });
  }
  mountTranscribe(r);
  mountModels(r, { instances });
  mountSystems(r);
  mountModelCatalog(r);
  mountTts(r);
  mountWorkspaceConventions(r);
  mountProjectConventions(r);
  mountConductorConventions(r);
  mountAccount(r, { claudeLogin, claudeAuthStatus });
  mountErrorHandler(r);

  return r;
}
