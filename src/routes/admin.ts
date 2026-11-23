import express from 'express';
import { runRestart, type RestartPhase, type ExitForShutdown } from '../restart.ts';
import { continuePendingNotices, type PendingContinue } from '../pendingContinue.ts';
import type { RunningRecorder } from '../runningRecord.ts';
import type { RootLock } from '../rootLock.ts';
import { withMaintenanceLock, type RelaunchPrep } from '../relaunchPrep.ts';
import { getSelfUpdateStatus, applySelfUpdate } from '../selfUpdate.ts';
import { applyClaudeUpdate } from '../claudeUpdate.ts';
import { probeClaudeBin } from '../health.ts';
import { streamNdjsonAction } from '../ndjsonAction.ts';
import { BOOT_ID } from '../bootId.ts';
import { hostPlatform, type PlatformCapabilities } from '../platform/index.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import { errMessage } from '../httpError.ts';
import { jsonBody, type ServerCtx } from './shared.ts';
import { errorBody } from './errors.ts';
import type { ServerRestartState } from '../../shared/wireRows.ts';
import type { HealthFocus } from '../../shared/focus.ts';

const UNRECORDED: ServerRestartState = { state: 'unknown', reason: 'this server did not record its boot commit' };
const unrecorded = async (): Promise<ServerRestartState> => UNRECORDED;

// What POST /admin/restart and /admin/shutdown run beyond the server handles:
// which preparation steps are on (server.ts maps CC_SKIP_WEB_BUILD /
// CC_SKIP_DEPS_SYNC onto `flags`), and — for tests — the steps themselves, the
// respawn and the shutdown's exit.
export interface RelaunchOptions {
  flags: { buildWeb: boolean; syncDeps: boolean };
  prep?: RelaunchPrep;
  spawnAndExit?: () => void | Promise<void>;
  exitForShutdown?: ExitForShutdown;
  // The projects-root lock this server holds; a restart hands it to the replacement.
  rootLock?: RootLock | null;
  // A headless run (src/headless/): nothing may replace this process.
  headless?: boolean;
  // A restart supervisor relaunches this server (src/restartSupervisor.ts).
  supervised?: boolean;
}

export function mountAdmin(r: express.Router, { instances, serverCtx, relaunch, recorder, pending, capabilities, restartStatus, viewOnly, focus = null }: { focus?: HealthFocus | null; viewOnly: boolean; instances?: InstanceManagerLike | null; serverCtx?: ServerCtx | null; relaunch: RelaunchOptions; recorder: RunningRecorder | null; pending: PendingContinue | null; capabilities: PlatformCapabilities; restartStatus?: (() => Promise<ServerRestartState>) | null }): void {
  // Cheap liveness + per-process identity probe. The client restart flow polls
  // this for a CHANGED bootId to confirm it's talking to the replacement
  // process, not the old one still up during a resume drain (see bootId.ts).
  r.get('/health', (_req, res) => {
    res.json({ ok: true, app: 'code-conductor', pid: process.pid, bootId: BOOT_ID, capabilities: viewOnly ? { ...capabilities, viewOnly: true } : capabilities, ...(focus ? { focus: { sessionId: focus.sessionId } } : {}) });
  });

  // The power menu's Restart and Shut down (runRestart, src/restart.ts). Both
  // drain every live turn to idle and write the resume manifest; a restart is
  // prepared first and then spawns a detached replacement and exits — or, under
  // a restart supervisor, releases the root lock and exits for the supervisor
  // to relaunch — and a shutdown exits with nothing to replace it. The restart
  // body's `autoContinue:true` (self-update) has the next boot prompt each busy
  // session at once; otherwise its notices wait for the resume banner. Streams
  // NDJSON like the self-update below: chunks per phase, then one result line —
  // `ok:true` once the step is committed and before networking goes down,
  // `ok:false` when a step refused it and cc keeps running. A restart, shutdown
  // or update already in progress answers 409 as plain JSON, and so does every
  // restart or shutdown of a headless run, before any step.
  // No-op 202 if the server context wasn't wired (in-process test boot).
  const maintenanceRoute = (action: 'restart' | 'shutdown') => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (relaunch.headless) {
      res.status(409).json(action === 'restart'
        ? { error: 'restart is disabled in headless mode', code: 'RESTART_DISABLED_HEADLESS' }
        : { error: 'shutdown is disabled in headless mode', code: 'SHUTDOWN_DISABLED_HEADLESS' });
      return;
    }
    if (!serverCtx) { res.status(202).json({ ok: true }); return; }
    const deliver = action === 'restart' && jsonBody(req).autoContinue === true ? 'auto' : 'gated';
    let streaming = false;
    const write = (obj: unknown) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
    withMaintenanceLock(action, () => {
      streaming = true;
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders();
      return runRestart({
        action,
        deliver,
        ctx: { server: serverCtx.server, wss: serverCtx.wss, instances },
        flags: relaunch.flags,
        prep: relaunch.prep,
        spawnAndExit: relaunch.spawnAndExit,
        exitForShutdown: relaunch.exitForShutdown,
        rootLock: relaunch.rootLock,
        supervised: relaunch.supervised,
        recorder,
        onChunk: (phase: RestartPhase, text: string) => write({ type: 'chunk', phase, text }),
        onCommit: () => { write({ type: 'result', ok: true }); res.end(); },
      });
    }).catch((e: unknown) => {
      if (!streaming) { next(e); return; }
      if (res.writableEnded) { console.error(`${action}: failed after it was committed:`, errMessage(e)); return; }
      write({ type: 'result', ok: false, ...errorBody(e), tail: (e as { tail?: unknown }).tail });
      res.end();
    });
  };
  r.post('/admin/restart', maintenanceRoute('restart'));
  r.post('/admin/shutdown', maintenanceRoute('shutdown'));

  // The resume banner: the continue notices a gated restore held back
  // (src/pendingContinue.ts). GET lists them with each live session's project
  // and title; Continue sends each to its session, Dismiss drops them all.
  r.get('/resume-notices', (_req, res) => {
    const notices = (pending?.list() ?? []).map((n) => {
      const s = instances?.liveForSession(n.sessionId)?.summary();
      return { sessionId: n.sessionId, kind: n.kind, project: s?.project ?? null, title: (s?.title ?? null) as string | null };
    });
    res.json({ notices });
  });
  r.post('/resume-notices/continue', (_req, res) => {
    res.json(pending && instances ? continuePendingNotices({ pending, instances }) : { sent: [], dropped: [] });
  });
  r.post('/resume-notices/dismiss', (_req, res) => {
    res.json({ dismissed: pending?.take().length ?? 0 });
  });

  // Conductor self-update — the app's own git-pull update path, surfaced on
  // Settings → About. GET reports version + git-behind detection; POST applies
  // (`git pull --ff-only` + conditional `npm install`), streamed as NDJSON.
  // The client hands off to the restart+resume flow after a successful apply
  // (performRestart, web/src/features/sidebar/restart.ts); the POST itself never
  // restarts the process. GET also carries `restart` (src/restartStatus.ts):
  // whether this server is behind its checkout's HEAD, `unknown` for a server
  // that recorded no boot commit.
  r.get('/settings/self-update', async (_req, res, next) => {
    try {
      const [status, restart] = await Promise.all([getSelfUpdateStatus(), (restartStatus ?? unrecorded)()]);
      res.json({ ...status, restart });
    } catch (e) { next(e); }
  });

  // Same streaming contract as the plugin library update (streamNdjsonAction,
  // src/ndjsonAction.ts): before onValidated fires a rejection is a normal
  // thrown error (→ trailing error middleware, preserving status codes); after
  // it, bytes are committed as 200 NDJSON and both outcomes resolve into one
  // terminal {type:'result',...} line.
  r.post('/settings/self-update', (_req, res, next) => streamNdjsonAction(res, next,
    (onChunk, onValidated) => applySelfUpdate({ onChunk, onValidated })));

  // Settings → About's Claude CLI update (src/claudeUpdate.ts) — same NDJSON
  // contract as self-update; no restart follows. GET is the `--version` probe.
  r.get('/settings/claude-update', async (_req, res, next) => {
    try { res.json(await probeClaudeBin({ platform: hostPlatform })); } catch (e) { next(e); }
  });
  r.post('/settings/claude-update', (_req, res, next) => streamNdjsonAction(res, next,
    (onChunk, onValidated) => applyClaudeUpdate({ platform: hostPlatform, onChunk: (t) => onChunk('update', t), onValidated })));
}
