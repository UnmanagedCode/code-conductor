import express from 'express';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import {
  listProjects, createProject, listSessions, listSessionsForCwd,
  summarizeSessions, deleteProject, deleteSessionForCwd, archiveSessionForCwd,
  listArchivedGroupedByProject, getProject,
  findSessionLocation, writeProjectMeta,
  addWorkspace, removeWorkspace, renameWorkspace,
  summarizeWorkspaces, validateName,
} from './projects.js';
import { WebSocket } from 'ws';
import {
  isGitRepo, listWorktrees, removeWorktree, mergeWorktreeIntoParent,
  buildRebasePrompt, getWorktree, removeAllWorktreesForProject,
  attachmentsDir, getWorktreeMergeStatus, syncWorktree,
  getProjectUpstreamStatus, getWorktreeDiff,
  getProjectCommits, getCommitDiff, getProjectUncommittedDiff,
} from './worktrees.js';
import { buildPluginApi } from './plugins/api.js';
import { scheduleRestart } from './restart.js';
import { drainAndScheduleRestart } from './resumeRestart.js';
import { BOOT_ID } from './bootId.js';
import { getOrCompute, invalidate, invalidateAll } from './projectsCache.js';
import { pageInstanceEvents } from './eventArchive.js';
import { ensureConductProject, CONDUCT_PROJECT_NAME } from './conduct.js';
import {
  isAvailable as transcribeAvailable, transcribe, modelPathForName,
} from './transcribe.js';
import { WHISPER_MODELS, isKnownModel, DEFAULT_MODEL } from './whisperModels.js';
import {
  MODEL_FAMILIES, CAPABILITY_TIERS, PROVIDERS, isKnownTier, ROLES, isKnownRole,
} from './modelVersions.js';
import {
  isAvailable as ttsAvailable, synthesize, voicePathForName,
} from './tts.js';
import { TTS_VOICES, isKnownVoice, DEFAULT_VOICE } from './ttsModels.js';
import { preflightOllamaBackend } from './ollamaBackend.js';
import { OLLAMA_CLOUD_MODELS, OLLAMA_CLOUD_TIER_DEFAULTS } from './ollamaCloudModels.js';
import {
  getTranscribeModel, setTranscribeModel,
  getTtsEnabled, setTtsEnabled, getTtsVoice, setTtsVoice, getTtsRate, setTtsRate,
  getOnOverageAction, setOnOverageAction,
  getOverageThreshold, setOverageThreshold,
  getConductorCompactWindow, setConductorCompactWindow,
  getEnabledTiers, setTierEnabled,
  getDefaultSpawnTier, setDefaultSpawnTier,
  getTierBackend, setTierBackend,
  getRoleBinding, setRoleBinding,
  getCustomBackends, addCustomBackend, removeCustomBackend,
} from './appSettings.js';
import * as whisperInstall from './whisperInstall.js';
import * as ttsInstall from './ttsInstall.js';
import { ensureRootClaudeMd } from './rootClaudeMd.js';
import { setTitle as setSessionTitle, MAX_TITLE_LEN } from './sessionTitles.js';
import { getSummaries, setSummary, deleteSummaries } from './sessionSummaries.js';
import { generateSummary, countMessages } from './summarize.js';
import { getAccountUsage } from './accountUsage.js';
import { getCostSummary, getSessionStats } from './costTracking.js';
import { isArchived, unmarkArchived } from './archivedSessions.js';
import {
  getCatalog as getProjectConventionsCatalog,
  composeProjectConventionsBlock, composeProjectScaffold,
  addCustomConvention as addProjectConvention,
  updateCustomConvention as updateProjectConvention,
  deleteCustomConvention as deleteProjectConvention,
} from './projectConventions.js';
import {
  CORE_META as CONDUCT_CORE_META,
  getCatalog as getConductorConventionsCatalog,
  getSelection as getConductorSelection,
  setSelection as setConductorSelection,
  addCustomConvention as addConductorConvention,
  updateCustomConvention as updateConductorConvention,
  deleteCustomConvention as deleteConductorConvention,
} from './conductorConventions.js';
import {
  CORE_META as WORKSPACE_CORE_META,
  getCatalog as getWorkspaceConventionsCatalog,
  getSelection as getWorkspaceSelection,
  setSelection as setWorkspaceSelection,
  addCustomConvention as addWorkspaceConvention,
  updateCustomConvention as updateWorkspaceConvention,
  deleteCustomConvention as deleteWorkspaceConvention,
} from './workspaceConventions.js';

// Session ids are user-supplied path params on many routes; this is the single
// allow-list + rejection (400 "invalid sessionId") they all share.
const SID_RE = /^[A-Za-z0-9_-]+$/;
function assertValidSid(sid) {
  if (!SID_RE.test(sid)) {
    throw Object.assign(new Error('invalid sessionId'), { statusCode: 400 });
  }
}

const CONTENT_TYPE_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8',
};

// Mounts the four parallel routes shared by the Settings → Transcribe and
// Settings → TTS groups: GET the catalog state, POST to switch the active item
// (allow-list + on-disk gate), POST to start an install, GET install status.
// cfg.itemKey ('model' | 'voice') drives the URL segment, the request-body
// field, and the active/list state keys; the on-disk-before-activate check is
// the allow-list enforcement point.
function mountInstallableCatalog(r, cfg) {
  const { prefix, itemKey, catalog, pathForName, isKnown, getActive, setActive,
          defaultName, available, installer, extraState } = cfg;
  const activeKey = `active${itemKey[0].toUpperCase()}${itemKey.slice(1)}`;
  const listKey = `${itemKey}s`;

  async function state() {
    const items = await Promise.all(catalog.map(async (it) => {
      let installed = false;
      try { installed = (await fs.stat(pathForName(it.name))).isFile(); } catch { /* missing */ }
      return { ...it, installed };
    }));
    return {
      available: await available(),
      [activeKey]: getActive() || defaultName,
      [listKey]: items,
      install: installer.status(),
      ...(extraState ? extraState() : {}),
    };
  }

  r.get(`/settings/${prefix}`, async (req, res, next) => {
    try { res.json(await state()); } catch (e) { next(e); }
  });

  r.post(`/settings/${prefix}/${itemKey}`, async (req, res, next) => {
    try {
      const name = req.body?.[itemKey];
      if (!isKnown(name)) {
        throw Object.assign(new Error(`unknown ${itemKey}`), { statusCode: 400 });
      }
      let onDisk = false;
      try { onDisk = (await fs.stat(pathForName(name))).isFile(); } catch { /* missing */ }
      if (!onDisk) {
        throw Object.assign(new Error(`${itemKey} not installed — install it first`), { statusCode: 400 });
      }
      await setActive(name);
      res.json(await state());
    } catch (e) { next(e); }
  });

  r.post(`/settings/${prefix}/install`, async (req, res, next) => {
    try {
      const result = installer.start(req.body?.[itemKey]);
      if (!result.started) return res.status(409).json({ ok: false, running: true });
      res.json({ ok: true, started: true });
    } catch (e) { next(e); }
  });

  r.get(`/settings/${prefix}/install/status`, (req, res) => {
    res.json(installer.status());
  });

  // Returned so sibling routes (e.g. tts /prefs) can reuse the exact state shape.
  return { state };
}

export function buildRoutes({ instances, serverCtx, pluginHost, pluginLibrary } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));
  // Plugin management API (GET /, rescan, enable/disable/start/stop/status/
  // version, library list/install) — delegates to the registry/library,
  // errors bubble to the middleware at the bottom of this router.
  r.use('/plugins', buildPluginApi({ pluginHost, pluginLibrary }));

  // Nudge every connected client to re-fetch /api/projects. Mirrors the
  // hint that wsHub.js broadcasts on instance lifecycle events — used
  // here when a route mutates project state outside that channel (e.g.
  // workspace assignment).
  function broadcastProjects() {
    const wss = serverCtx?.wss;
    if (!wss) return;
    const msg = JSON.stringify({ t: 'projects' });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { /* ignore */ }
      }
    }
  }

  // Self-respawn the orchestrator. Sends 202 immediately, then spawns
  // a detached replacement node process and exits. Frontend's existing
  // 1s WS reconnect loop handles the brief downtime. No-op if the
  // server context wasn't wired (in-process test boot).
  // Cheap liveness + per-process identity probe. The client restart flow polls
  // this for a CHANGED bootId to confirm it's talking to the replacement
  // process, not the old one still up during a resume drain (see bootId.js).
  r.get('/health', (req, res) => {
    res.json({ ok: true, bootId: BOOT_ID });
  });

  r.post('/admin/restart', (req, res) => {
    res.status(202).json({ ok: true });
    if (!serverCtx) return;
    const ctx = { server: serverCtx.server, wss: serverCtx.wss, instances };
    // `resume:true` ⇒ graceful drain → restart → resurrect (carries temps
    // over). Otherwise the normal hard restart (wipes temps).
    if (req.body?.resume) drainAndScheduleRestart(ctx);
    else scheduleRestart(ctx);
  });

  // Compute the git-heavy facts for one project. Called via getOrCompute() so
  // results are cached for TTL_MS and concurrent callers share one in-flight
  // execution. Does NOT include sessionIds or session counts — those are cheap
  // and always computed fresh so they stay live across status changes.
  async function computeGitFacts(p) {
    const worktrees = await listWorktrees(p.name).catch(() => []);
    const worktreesWithMerge = await Promise.all(worktrees.map(async (w) => ({
      ...w,
      mergeStatus: await getWorktreeMergeStatus(w).catch(() => ({ ahead: null, behind: null })),
    })));
    const projIsGitRepo = await isGitRepo(p.path);
    return {
      isGitRepo: projIsGitRepo,
      worktrees: worktreesWithMerge,
      mergeStatus: projIsGitRepo
        ? await getProjectUpstreamStatus(p.path).catch(() => ({ ahead: null, behind: null, upstream: null }))
        : { ahead: null, behind: null, upstream: null },
    };
  }

  r.get('/projects', async (req, res, next) => {
    try {
      const projects = await listProjects();
      const enriched = await Promise.all(projects.map(async (p) => {
        // Git facts are cached for TTL_MS; concurrent requests coalesce.
        const gitFacts = await getOrCompute(p.name, () => computeGitFacts(p));
        // Attach a lightweight session count + last-active mtime to
        // each worktree too, so the sidebar can decide whether to show
        // its "Sessions (N)" subnode without an extra fetch.
        const worktreesWithSessions = await Promise.all(gitFacts.worktrees.map(async (w) => {
          const wtTempSids = instances ? instances.tempSessionIdsForCwd(w.worktreePath) : null;
          return {
            ...w,
            sessions: await summarizeSessions(w.worktreePath, wtTempSids).catch(() => ({ count: 0, archivedCount: 0, lastMtime: 0 })),
          };
        }));
        const projTempSids = instances ? instances.tempSessionIdsForCwd(p.path) : null;
        return {
          ...p,
          sessionIds: instances ? instances.sessionIdsForProject(p.name) : [],
          isGitRepo: gitFacts.isGitRepo,
          worktrees: worktreesWithSessions,
          sessions: await summarizeSessions(p.path, projTempSids).catch(() => ({ count: 0, archivedCount: 0, lastMtime: 0 })),
          mergeStatus: gitFacts.mergeStatus,
        };
      }));
      res.json(enriched);
    } catch (e) { next(e); }
  });

  r.post('/projects', async (req, res, next) => {
    try {
      const { name, conventions } = req.body ?? {};
      // Validate the regex first so callers that hit BOTH conditions
      // (e.g. "../escape" — starts with "." AND contains "/") get the
      // canonical "invalid project name" error rather than the dot-prefix
      // one. Then refuse dot-prefixed names that *did* pass the regex —
      // those are reserved for orchestrator-managed hidden projects
      // (currently just `.conduct`).
      validateName(name);
      if (name.startsWith('.')) {
        throw Object.assign(
          new Error('invalid project name (cannot start with "." — reserved for orchestrator-managed projects)'),
          { statusCode: 400 },
        );
      }
      if (conventions !== undefined && !Array.isArray(conventions)) {
        throw Object.assign(new Error('conventions must be an array of slug strings'), { statusCode: 400 });
      }
      const appendToCLAUDEmd = await composeProjectConventionsBlock(conventions ?? []);
      const scaffold = await composeProjectScaffold(name, conventions ?? []);
      const created = await createProject(name, { appendToCLAUDEmd });
      // Scaffold directive is returned (not persisted) — the caller folds it
      // into the first worker brief. See conventions/conductor/core.md.
      res.status(201).json({ ...created, ...(scaffold ? { scaffold } : {}) });
    } catch (e) { next(e); }
  });

  // Lazy-create the hidden `.conduct` project that hosts Conduct sessions.
  // Mounted at a literal path so the regular /projects/:name guards don't
  // need to special-case the name and so curl-ing this never spawns a
  // visible project. Idempotent — second call is a fast no-op.
  r.post('/projects/.conduct/ensure', async (req, res, next) => {
    try {
      const result = await ensureConductProject();
      res.json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  // Delete a project + all attached state. Cascade:
  //   1. validate the project exists,
  //   2. kill every running instance attached to it (including any
  //      inside worktrees of this project),
  //   3. remove every worktree (git worktree remove --force + branch
  //      delete + dir sweep for orphans),
  //   4. rm -rf the project directory itself.
  // Sessions under ~/.claude/projects/<encoded>/ are intentionally
  // left alone — they belong to the user's claude CLI history and
  // may still be referenced outside the orchestrator.
  r.delete('/projects/:name', async (req, res, next) => {
    try {
      if (req.params.name === CONDUCT_PROJECT_NAME) {
        throw Object.assign(
          new Error('the .conduct project is managed by the orchestrator and cannot be deleted via this endpoint'),
          { statusCode: 400 },
        );
      }
      const proj = await getProject(req.params.name);
      let killed = 0;
      if (instances) killed = await instances.removeAllForProject(proj.name);
      await removeAllWorktreesForProject(proj.name);
      await deleteProject(proj.name);
      invalidate(proj.name);
      res.json({ ok: true, project: proj.name, killedInstances: killed });
    } catch (e) { next(e); }
  });

  // Assign or clear the project's workspace. Body: {workspace: string|null}.
  // An empty string is treated as null (clears the field). Workspace names
  // are validated in writeProjectMeta — see validateWorkspace() in projects.js.
  // Setting a non-null workspace auto-registers it (so newly-named
  // workspaces appear in /api/workspaces). A successful write broadcasts
  // the `projects` WS hint so connected sidebars re-fetch and rebucket
  // immediately, including the `+ Workspace` dialog if it's open.
  r.put('/projects/:name/workspace', async (req, res, next) => {
    try {
      if (req.params.name === CONDUCT_PROJECT_NAME) {
        throw Object.assign(
          new Error('the .conduct project cannot be assigned to a workspace'),
          { statusCode: 400 },
        );
      }
      await getProject(req.params.name);
      const raw = req.body?.workspace;
      const target = raw === '' || raw === undefined ? null : raw;
      const meta = await writeProjectMeta(req.params.name, { workspace: target });
      if (meta.workspace) {
        try { await addWorkspace(meta.workspace); } catch { /* validation already ran in writeProjectMeta */ }
      }
      broadcastProjects();
      res.json({ ok: true, name: req.params.name, workspace: meta.workspace ?? null });
    } catch (e) { next(e); }
  });

  // ── Workspace registry endpoints ────────────────────────────────────
  // Workspaces persist independently of membership: an empty workspace
  // stays visible in the sidebar. The registry is the union source.

  r.get('/workspaces', async (req, res, next) => {
    try {
      res.json(await summarizeWorkspaces());
    } catch (e) { next(e); }
  });

  r.post('/workspaces', async (req, res, next) => {
    try {
      const { name } = req.body ?? {};
      const result = await addWorkspace(name);
      broadcastProjects();
      res.status(result.added ? 201 : 200).json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  r.delete('/workspaces/:name', async (req, res, next) => {
    try {
      const result = await removeWorkspace(req.params.name);
      broadcastProjects();
      res.json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  r.put('/workspaces/:name', async (req, res, next) => {
    try {
      const newName = req.body?.name;
      const result = await renameWorkspace(req.params.name, newName);
      broadcastProjects();
      res.json({ ok: true, ...result });
    } catch (e) { next(e); }
  });

  r.get('/projects/:name/sessions', async (req, res, next) => {
    try {
      const proj = await getProject(req.params.name);
      const tempSids = instances ? instances.tempSessionIdsForCwd(proj.path) : null;
      const sessions = await listSessionsForCwd(proj.path, tempSids, { includeArchived: !!req.query.includeArchived });
      res.json(sessions);
    } catch (e) { next(e); }
  });

  // List worktrees that belong to a project. Returns the same metadata
  // shape that's stored in each worktree's .code-conductor/worktree.json,
  // augmented with the currently-running session id(s) (if any).
  r.get('/projects/:name/worktrees', async (req, res, next) => {
    try {
      const wts = await listWorktrees(req.params.name);
      const enriched = wts.map(w => ({
        ...w,
        sessionIds: instances ? instances.sessionIdsForWorktree(req.params.name, w.worktreeName) : [],
      }));
      res.json(enriched);
    } catch (e) { next(e); }
  });

  // Shared by both DELETE-session endpoints below. Refuses 409 when a
  // running instance has this sessionId — `claude --resume <sid>`
  // would otherwise be looking at a deleted jsonl mid-turn. ?force=1
  // kills attached instances first, then deletes.
  // Detach every instance pointing at `sessionId` before its jsonl is
  // deleted/archived: 409 if a running one is attached (unless force), else
  // force-remove running ones and always drop the exited/crashed ones (leaving
  // them in byId would surface as a ghost sidebar row / let Resume reattach a
  // jsonl that's about to change). `verb` is the action phrase in the 409 (the
  // only difference between the delete and archive paths).
  async function detachInstancesForSession({ sessionId, force, verb }) {
    if (!instances) return;
    const attached = instances.idsForSession(sessionId)
      .map(id => instances.get(id))
      .filter(Boolean);
    const running = attached.filter(i => i.proc);
    if (running.length > 0 && !force) {
      throw Object.assign(new Error(
        `session ${sessionId} is attached to a running instance — ${verb} or pass force=1`,
      ), { statusCode: 409 });
    }
    if (force) {
      await Promise.all(running.map(i => instances.remove(i.id).catch(() => {})));
    }
    const stale = attached.filter(i => !i.proc);
    await Promise.all(stale.map(i => instances.remove(i.id).catch(() => {})));
  }

  async function deleteSessionAtCwd({ cwd, sessionId, force }) {
    await detachInstancesForSession({ sessionId, force, verb: 'kill it first' });
    const removed = await deleteSessionForCwd(cwd, sessionId);
    if (!removed) {
      throw Object.assign(new Error(`session ${sessionId} not found`), { statusCode: 404 });
    }
    // Best-effort — a missing summary never fails a delete.
    deleteSummaries(sessionId).catch(() => {});
  }

  r.delete('/projects/:name/sessions/:sid', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      const proj = await getProject(req.params.name);
      const force = req.query.force === '1' || req.query.force === 'true';
      await deleteSessionAtCwd({ cwd: proj.path, sessionId: sid, force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete('/projects/:name/worktrees/:wt/sessions/:sid', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      const wt = await getWorktree(req.params.name, req.params.wt);
      if (!wt) throw Object.assign(new Error('worktree not found'), { statusCode: 404 });
      const force = req.query.force === '1' || req.query.force === 'true';
      await deleteSessionAtCwd({ cwd: wt.worktreePath, sessionId: sid, force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Shared by both archive-session endpoints below. Mirrors
  // deleteSessionAtCwd's running-instance guard: a session attached to a
  // live instance refuses with 409 unless ?force=1, which stops the
  // instance first (so the archived session leaves the sidebar cleanly).
  // Unlike delete, this keeps the jsonl — it only records the sessionId
  // in the global archived set.
  async function archiveSessionAtCwd({ cwd, sessionId, force }) {
    await detachInstancesForSession({ sessionId, force, verb: 'stop it first' });
    const archived = await archiveSessionForCwd(cwd, sessionId);
    if (!archived) {
      throw Object.assign(new Error(`session ${sessionId} not found`), { statusCode: 404 });
    }
  }

  r.post('/projects/:name/sessions/:sid/archive', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      const proj = await getProject(req.params.name);
      const force = req.query.force === '1' || req.query.force === 'true';
      await archiveSessionAtCwd({ cwd: proj.path, sessionId: sid, force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/projects/:name/worktrees/:wt/sessions/:sid/archive', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      const wt = await getWorktree(req.params.name, req.params.wt);
      if (!wt) throw Object.assign(new Error('worktree not found'), { statusCode: 404 });
      const force = req.query.force === '1' || req.query.force === 'true';
      await archiveSessionAtCwd({ cwd: wt.worktreePath, sessionId: sid, force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // All archived sessions, grouped by the project (+ worktree) that owns
  // them — backs the Settings → Archived page.
  r.get('/archived', async (req, res, next) => {
    try {
      res.json({ groups: await listArchivedGroupedByProject() });
    } catch (e) { next(e); }
  });

  // Restore an archived session to the normal session list.
  // Idempotent — restoring a non-archived session is a no-op.
  r.post('/projects/:name/sessions/:sid/restore', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      await unmarkArchived(sid);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/projects/:name/worktrees/:wt/sessions/:sid/restore', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      await unmarkArchived(sid);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Per-worktree session list — needed by the new-instance dialog when
  // the user is spawning into an existing worktree (the worktree has its
  // own ~/.claude/projects/<encoded>/ history, distinct from the parent).
  r.get('/projects/:name/worktrees/:wt/sessions', async (req, res, next) => {
    try {
      const wt = await getWorktree(req.params.name, req.params.wt);
      if (!wt) throw Object.assign(new Error('worktree not found'), { statusCode: 404 });
      const tempSids = instances ? instances.tempSessionIdsForCwd(wt.worktreePath) : null;
      const wtSessions = await listSessionsForCwd(wt.worktreePath, tempSids, { includeArchived: !!req.query.includeArchived });
      res.json(wtSessions);
    } catch (e) { next(e); }
  });

  // Structured diff for a worktree vs its base branch. Returns per-file
  // data with hunks parsed for direct rendering — no client-side diffing
  // needed. Accepts optional ?baseRef= and ?context= (0–50, default 3).
  r.get('/projects/:name/worktrees/:wt/diff', async (req, res, next) => {
    try {
      const baseRef = req.query.baseRef || undefined;
      const contextLines = req.query.context !== undefined ? Number(req.query.context) : 3;
      const result = await getWorktreeDiff(req.params.name, req.params.wt, { baseRef, contextLines });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Commit history (git log) for a project's current branch (HEAD), newest
  // first. Accepts optional ?limit= (default 100, max 500). Returns
  // { project, branch, commits, truncated, limit }.
  r.get('/projects/:name/commits', async (req, res, next) => {
    try {
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
      const result = await getProjectCommits(req.params.name, { limit });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Diff of all uncommitted changes (staged + unstaged vs HEAD). Mirrors the
  // commit /diff response shape so the same client renderer applies.
  // Registered before the :sha route so the literal "uncommitted" isn't
  // treated as a SHA param.
  r.get('/projects/:name/commits/uncommitted/diff', async (req, res, next) => {
    try {
      const contextLines = req.query.context !== undefined ? Number(req.query.context) : 3;
      const result = await getProjectUncommittedDiff(req.params.name, { contextLines });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Structured diff for the change introduced by a single commit. Mirrors the
  // worktree /diff response shape so the same client renderer applies.
  // Accepts optional ?context= (0–50, default 3).
  r.get('/projects/:name/commits/:sha/diff', async (req, res, next) => {
    try {
      const contextLines = req.query.context !== undefined ? Number(req.query.context) : 3;
      const result = await getCommitDiff(req.params.name, req.params.sha, { contextLines });
      res.json(result);
    } catch (e) { next(e); }
  });

  // Remove a worktree. Refuses if there's a live instance attached or
  // the worktree has uncommitted changes (unless ?force=1).
  r.delete('/projects/:name/worktrees/:wt', async (req, res, next) => {
    try {
      const force = req.query.force === '1' || req.query.force === 'true';
      if (instances) {
        const running = instances.idsForWorktree(req.params.name, req.params.wt)
          .map(id => instances.get(id))
          .filter(i => i && i.proc);
        if (running.length > 0 && !force) {
          throw Object.assign(new Error(
            `worktree has ${running.length} running instance(s) — kill them first or pass force=1`,
          ), { statusCode: 409 });
        }
        // With force, kill any attached instances before removing.
        if (force) {
          await Promise.all(running.map(i => i.kill({ graceMs: 300 }).catch(() => {})));
        }
      }
      await removeWorktree(req.params.name, req.params.wt, { force });
      invalidate(req.params.name);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Locate which project / worktree owns a given sessionId. Used by the
  // frontend's auto-resume-from-URL-anchor flow: a refresh that lands on a
  // page anchored to a session whose live instance is gone (server restart,
  // killed instance, etc.) hits this endpoint to find the right cwd to
  // resume into.
  // Set or clear a custom human-readable title for a session. Empty /
  // whitespace-only / null title clears the entry. The new title is
  // capped at MAX_TITLE_LEN. Broadcasts a `projects` hint so sidebars
  // refetch, and pushes the updated summary to any live instance(s)
  // currently attached to this sessionId so the active header chip
  // re-renders without a page reload.
  r.put('/sessions/:sessionId/title', async (req, res, next) => {
    try {
      const sid = String(req.params.sessionId || '');
      assertValidSid(sid);
      const raw = req.body?.title;
      if (raw != null && typeof raw !== 'string') {
        throw Object.assign(new Error('title must be a string'), { statusCode: 400 });
      }
      const stored = await setSessionTitle(sid, raw ?? '');
      if (instances) {
        for (const id of instances.idsForSession(sid)) {
          const inst = instances.get(id);
          if (inst) inst.setTitle(stored);
        }
      }
      broadcastProjects();
      res.json({ ok: true, sessionId: sid, title: stored, maxLength: MAX_TITLE_LEN });
    } catch (e) { next(e); }
  });

  // Resolve the filesystem cwd for a session from findSessionLocation's result.
  async function cwdForHit(hit) {
    if (!hit) return null;
    if (hit.worktreeName) {
      const wt = await getWorktree(hit.project, hit.worktreeName);
      return wt?.worktreePath ?? null;
    }
    const proj = await getProject(hit.project);
    return proj.path;
  }

  // Build the three-tier response data object, adding per-tier isStale.
  // currentCount should be pre-fetched (once) and passed in.
  function buildTierData(tiers, currentCount) {
    const LENGTHS = ['short', 'medium', 'long'];
    const data = {};
    for (const len of LENGTHS) {
      const t = tiers[len];
      data[len] = t
        ? { ...t, isStale: currentCount > t.messageCount }
        : null;
    }
    return data;
  }

  // Retrieve all stored summaries for a session, with per-tier staleness.
  // Returns { short, medium, long } where each tier is null when absent.
  r.get('/sessions/:sessionId/summary', async (req, res, next) => {
    try {
      const sid = String(req.params.sessionId || '');
      assertValidSid(sid);
      const tiers = await getSummaries(sid);
      let currentCount = 0;
      const hasTiers = Object.keys(tiers).length > 0;
      if (hasTiers) {
        const hit = await findSessionLocation(sid);
        if (hit) {
          const cwd = await cwdForHit(hit);
          if (cwd) currentCount = await countMessages(sid, cwd).catch(() => 0);
        }
      }
      res.json({ ok: true, sessionId: sid, data: buildTierData(tiers, currentCount) });
    } catch (e) { next(e); }
  });

  // Generate (or regenerate) one tier for a session via a one-shot Haiku call.
  // Merges the new tier into the session's existing record without clobbering
  // other tiers. Returns the same full three-tier data shape as GET so the
  // client can refresh its cache in one round-trip.
  r.post('/sessions/:sessionId/summary', async (req, res, next) => {
    try {
      const sid = String(req.params.sessionId || '');
      assertValidSid(sid);
      const length = req.body?.length;
      if (!['short', 'medium', 'long'].includes(length)) {
        throw Object.assign(new Error('length must be short, medium, or long'), { statusCode: 400 });
      }
      const hit = await findSessionLocation(sid);
      if (!hit) throw Object.assign(new Error('session not found'), { statusCode: 404 });
      const cwd = await cwdForHit(hit);
      if (!cwd) throw Object.assign(new Error('session not found'), { statusCode: 404 });
      const { summary, messageCount } = await generateSummary(sid, cwd, length);
      await setSummary(sid, length, { summary, generatedAt: Date.now(), messageCount });
      broadcastProjects();
      // Re-fetch all tiers so the response mirrors the GET shape.
      const tiers = await getSummaries(sid);
      const currentCount = await countMessages(sid, cwd).catch(() => 0);
      res.json({ ok: true, sessionId: sid, data: buildTierData(tiers, currentCount) });
    } catch (e) { next(e); }
  });

  r.get('/sessions/:sessionId/locate', async (req, res, next) => {
    try {
      const sid = String(req.params.sessionId || '');
      assertValidSid(sid);
      const hit = await findSessionLocation(sid);
      if (!hit) throw Object.assign(new Error('session not found'), { statusCode: 404 });
      // Report archived-ness so the client's anchor auto-resume can skip a
      // session that was archived on a plain restart (its jsonl is retained,
      // so locate still 200s) instead of silently resurrecting it. Deliberate
      // resume-from-archived stays allowed — this only feeds the automatic path.
      res.json({ ...hit, archived: await isArchived(sid) });
    } catch (e) { next(e); }
  });

  if (instances) {
    r.get('/instances', (req, res) => {
      res.json(instances.list());
    });

    r.post('/instances', async (req, res, next) => {
      try {
        const { project, resume, mode, effort, thinking, model, sonnetWindow, backendKind, worktree, temp, debug, autoApprovePlan } = req.body ?? {};
        // UI shortcut: the temp checkbox implies bypassPermissions when no
        // mode is picked (a disposable session is almost always for *doing*,
        // not planning). create() is policy-light and no longer couples
        // these, so the mapping lives here. An explicit mode still wins.
        const effectiveMode = (mode == null && temp) ? 'bypassPermissions' : mode;
        const inst = await instances.create({ project, resume, mode: effectiveMode, effort, thinking, model, sonnetWindow, backendKind, worktree, temp, debug, autoApprovePlan });
        res.status(201).json(inst.summary());
      } catch (e) { next(e); }
    });

    r.post('/instances/:id/respawn', async (req, res, next) => {
      try {
        const inst = await instances.respawn(req.params.id);
        res.json(inst.summary());
      } catch (e) { next(e); }
    });

    // Paged event history, including events evicted from the capped ring
    // (reconstructed from the session jsonl — see src/eventArchive.js).
    // `before=<seq>` pages backward (up to `limit` events immediately
    // preceding that seq, oldest-first; the UI's scroll-up path — echo the
    // response's `nextBefore` cursor back to continue). `after=<seq>` pages
    // forward (first `limit` events with seq > after). Neither → trailing
    // `limit` events. `limit` clamped to [1, 500], default 200. Responds
    // { id, events, hasMore, nextBefore, trimmedBefore, lastSeq }.
    r.get('/instances/:id/events', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        const parseIntParam = (v, name) => {
          if (v === undefined) return null;
          const n = Number(v);
          if (!Number.isInteger(n)) {
            throw Object.assign(new Error(`${name} must be an integer`), { statusCode: 400 });
          }
          return n;
        };
        const before = parseIntParam(req.query.before, 'before');
        const after = parseIntParam(req.query.after, 'after');
        const limit = parseIntParam(req.query.limit, 'limit') ?? undefined;
        const page = await pageInstanceEvents(inst, { before, after, limit });
        res.json({ id: inst.id, ...page });
      } catch (e) { next(e); }
    });

    // Rewind the active session to before the Nth user prompt (0-indexed
    // among emitted user_echo events). Kills the subprocess, truncates the
    // persisted jsonl, broadcasts a snapshot_reset so subscribers clear
    // their conversation, then respawns with --resume so the surviving
    // prefix is replayed. Returns { ok:true, droppedText } so the
    // frontend can prefill the composer with the removed prompt.
    r.post('/instances/:id/rewind', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        const idx = Number((req.body ?? {}).userMessageIndex);
        if (!Number.isInteger(idx) || idx < 0) {
          throw Object.assign(new Error('userMessageIndex must be a non-negative integer'), { statusCode: 400 });
        }
        const { droppedText } = await inst.rewindToUserMessage(idx);
        res.json({ ok: true, droppedText });
      } catch (e) { next(e); }
    });

    // Fork the session of the named instance: copy the prefix of its
    // jsonl up to (excluding) the Nth user prompt into a new sessionId,
    // leave the original session intact, and spawn a fresh instance
    // resuming the forked jsonl. The composer prefill rides the new
    // instance's first `snapshot` frame as `droppedText` (stored via
    // create({prefill}); consumed once in wsHub) — the inline analogue of
    // rewind's `reset_snapshot`. Returns the new instance summary plus
    // { newSessionId, droppedText } (informational; symmetric with /rewind).
    r.post('/instances/:id/fork', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        if (inst.temp) throw Object.assign(new Error('temp sessions cannot be forked'), { statusCode: 400 });
        if (!inst.sessionId) {
          throw Object.assign(new Error('no sessionId — instance has not yet received a turn'), { statusCode: 400 });
        }
        const idx = Number((req.body ?? {}).userMessageIndex);
        if (!Number.isInteger(idx) || idx < 0) {
          throw Object.assign(new Error('userMessageIndex must be a non-negative integer'), { statusCode: 400 });
        }
        // Defer the import until first use — keeps the routes module light
        // and avoids pulling sessionEdit into the test paths that don't
        // exercise it.
        const { forkSessionAtUserMessage } = await import('./sessionEdit.js');
        const { newSessionId, droppedText } = await forkSessionAtUserMessage({
          cwd: inst.cwd,
          sessionId: inst.sessionId,
          userMessageIndex: idx,
          permissionMode: inst.mode === 'ask' ? 'bypassPermissions' : inst.mode,
        });
        // Spawn the fork as a new instance against the same cwd / worktree.
        const newInst = await instances.create({
          project: inst.project,
          resume: newSessionId,
          mode: inst.mode,
          effort: inst.effort,
          thinking: inst.thinking,
          model: inst.model,
          sonnetWindow: inst.sonnetWindow,
          worktree: inst.worktree?.worktreeName ?? null,
          prefill: droppedText,
        });
        res.status(201).json({
          ok: true,
          newSessionId,
          droppedText,
          instance: newInst.summary(),
        });
      } catch (e) { next(e); }
    });

    r.delete('/instances/:id', async (req, res, next) => {
      try {
        await instances.remove(req.params.id);
        res.json({ ok: true });
      } catch (e) { next(e); }
    });

    // Promote a temp session to a regular one. 404 on unknown id, 400
    // when the instance is not temp (no-op would be confusing — better
    // to surface the misuse). The summary broadcast that follows the
    // status emit lets the sidebar migrate the row from the Temp
    // Sessions subnode into the regular Sessions list.
    r.post('/instances/:id/promote', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        const summary = await inst.promoteToNormal();
        res.json({ ok: true, instance: summary });
      } catch (e) { next(e); }
    });

    // Flip debug capture ON for a running instance. No matching "off"
    // endpoint — append-mode logs are best-effort and live for the rest
    // of the subprocess's life; to stop capturing, kill the instance.
    r.post('/instances/:id/debug', (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) {
          return res.status(404).json({ error: 'instance not found' });
        }
        const result = inst.enableDebug();
        if (!result.ok) return res.status(500).json(result);
        res.json({
          ok: true,
          debug: inst.debug,
          debugDir: inst.debugDir,
          alreadyOn: !!result.alreadyOn,
        });
      } catch (e) { next(e); }
    });

    // Sync a worktree from its parent's baseBranch. Server-side FF
    // when possible; otherwise sends the templated rebase prompt to
    // the worktree's agent. Returns {ok:true, action} on success
    // (action ∈ already-in-sync | fast-forwarded | rebase-prompt-sent)
    // or {ok:false, reason} when neither path is available.
    r.post('/instances/:id/sync', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        if (!inst.worktree) throw Object.assign(new Error('instance is not attached to a worktree'), { statusCode: 400 });
        const result = await syncWorktree(inst.project, inst.worktree.worktreeName);
        if (result.ok && result.action === 'rebase-required') {
          if (!inst.proc) {
            invalidate(inst.project);
            res.json({
              ok: false,
              reason: 'instance is not running — Resume it before clicking Sync so the agent can rebase',
            });
            return;
          }
          await inst.prompt(buildRebasePrompt(inst.worktree), [], { annotateIfMidTurn: false });
          invalidate(inst.project);
          res.json({ ok: true, action: 'rebase-prompt-sent', ahead: result.ahead, behind: result.behind });
          return;
        }
        invalidate(inst.project);
        res.json(result);
      } catch (e) { next(e); }
    });

    // Merge the worktree's branch into the parent repo with a real merge
    // commit (--no-ff). Refuses with a friendly reason if the worktree
    // hasn't been synced yet (parent has commits the worktree branch
    // doesn't carry — the merge would still work, but conflicts would
    // pop on the parent side instead of being resolved inside the worktree
    // where the agent can help). Returns {ok:true, newSha} or
    // {ok:false, reason} — callers render the reason inline rather than
    // treating non-mergeable states as a server error.
    r.post('/instances/:id/merge', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        if (!inst.worktree) throw Object.assign(new Error('instance is not attached to a worktree'), { statusCode: 400 });
        // The behind-guard now lives inside mergeWorktreeIntoParent (shared with
        // the MCP handler); map its typed refusal to this surface's exact wording
        // + status (HTTP 200, no cache invalidation — nothing changed).
        const allowDirty = req.body?.allowDirty === true;
        const result = await mergeWorktreeIntoParent(inst.project, inst.worktree.worktreeName, { allowDirty });
        if (result.code === 'WORKTREE_BEHIND') {
          res.json({
            ok: false,
            reason: `worktree is behind '${result.baseBranch}' by ${result.behind} commit(s) — click Sync first to fast-forward / rebase`,
          });
          return;
        }
        invalidate(inst.project);
        res.json(result);
      } catch (e) { next(e); }
    });

    // PreToolUse http hook callback. The Claude Code CLI POSTs the hook
    // envelope here when a gated tool is about to run; we either
    // auto-allow (non-ask mode) or hold the response open and surface a
    // permission_request to the UI (ask mode) — the user's Allow/Deny
    // click eventually resolves the response. Response shape mirrors the
    // CLI's expected hookSpecificOutput JSON.
    // Serve a previously-saved attachment from the instance's central-
    // store attachments dir. The frontend uses this to populate user-
    // bubble thumbnails on transcript replay (the bytes aren't echoed
    // back via the WS user_echo on a fresh page load because they were
    // never written to the session jsonl).
    r.get('/instances/:id/attachments/:filename', async (req, res, next) => {
      try {
        const inst = instances.get(req.params.id);
        if (!inst) throw Object.assign(new Error('instance not found'), { statusCode: 404 });
        const raw = String(req.params.filename || '');
        // Path-traversal guard: reject anything that isn't a plain basename.
        if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw !== path.basename(raw)) {
          throw Object.assign(new Error('invalid attachment filename'), { statusCode: 400 });
        }
        const abs = path.join(
          attachmentsDir(inst.project, inst.worktree?.worktreeName ?? null),
          raw,
        );
        let stat;
        try { stat = await fs.stat(abs); }
        catch (e) {
          if (e.code === 'ENOENT') throw Object.assign(new Error('attachment not found'), { statusCode: 404 });
          throw e;
        }
        if (!stat.isFile()) throw Object.assign(new Error('attachment not found'), { statusCode: 404 });
        const ext = (raw.split('.').pop() || '').toLowerCase();
        const ctype = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
        res.setHeader('Content-Type', ctype);
        res.setHeader('Content-Length', String(stat.size));
        // Cache aggressively — the filename includes a timestamp so it's
        // effectively immutable. Saves a re-fetch on every conversation
        // re-render.
        res.setHeader('Cache-Control', 'private, max-age=3600');
        createReadStream(abs).pipe(res);
      } catch (e) { next(e); }
    });

    r.post('/instances/:id/hook-callback', (req, res) => {
      const inst = instances.get(req.params.id);
      if (!inst) {
        // The CLI is the instance's own subprocess so this branch is
        // theoretical, but reply deterministically: 200 + deny body so
        // the CLI doesn't fall into its non-blocking-error path.
        res.status(200).json({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'orchestrator: instance not found',
          },
        });
        return;
      }
      inst.handleHookCallback(req.body ?? {}, res);
    });
  }

  // Voice dictation: the composer's mic button streams a recorded audio
  // blob here, the server runs whisper.cpp locally and returns the text.
  // /status drives the frontend's button-visibility — both binaries must
  // be present or the mic button stays hidden.
  r.get('/transcribe/status', async (req, res, next) => {
    try {
      const available = await transcribeAvailable();
      res.json({ available });
    } catch (e) { next(e); }
  });

  r.post('/transcribe', express.raw({ type: '*/*', limit: '25mb' }), async (req, res, next) => {
    try {
      if (!(await transcribeAvailable())) {
        throw Object.assign(new Error('whisper.cpp not installed — run bin/install-whisper.sh'), { statusCode: 503 });
      }
      const text = await transcribe(req.body);
      res.json({ text });
    } catch (e) { next(e); }
  });

  // Settings → Transcribe group. Reports the curated model catalog (with
  // per-model on-disk presence), the active model (the explicit choice else the
  // built-in default, per resolveModelPath), and lets the UI switch models /
  // kick off an install of whisper.cpp + a chosen model.
  mountInstallableCatalog(r, {
    prefix: 'transcribe',
    itemKey: 'model',
    catalog: WHISPER_MODELS,
    pathForName: modelPathForName,
    isKnown: isKnownModel,
    getActive: getTranscribeModel,
    setActive: setTranscribeModel,
    defaultName: DEFAULT_MODEL,
    available: transcribeAvailable,
    installer: whisperInstall,
  });

  // Settings → Models group. Reports the two provider backends, the Claude
  // version catalog (MODEL_FAMILIES — the Anthropic backend's model list), the
  // user's custom Ollama models, the curated Ollama cloud preset catalog +
  // its per-tier defaults, the capability-tier list + each tier's
  // {kind, model} binding, the role list + each role's stored binding (a tier
  // binding {kind:'tier',tier} or a custom {kind,model}). A Sonnet 4.x Claude
  // binding carries its own context window as {kind:'claude',model,window} —
  // there is no global Sonnet-window preference.
  function modelsSettingsState() {
    const tierBackend = {};
    for (const t of CAPABILITY_TIERS) {
      tierBackend[t.tier] = getTierBackend(t.tier); // {kind, model, window?}
    }
    const roleBackend = {};
    for (const r of ROLES) {
      roleBackend[r.role] = getRoleBinding(r.role); // {kind:'tier',tier} | {kind,model,window?}
    }
    return { providers: PROVIDERS, backends: MODEL_FAMILIES, onOverage: getOnOverageAction(),
      overageThreshold: getOverageThreshold(),
      conductorCompactWindow: getConductorCompactWindow(),
      tiers: CAPABILITY_TIERS,
      tierBackend,
      roles: ROLES,
      roleBackend,
      customBackends: getCustomBackends(),
      ollamaCloudModels: OLLAMA_CLOUD_MODELS,
      ollamaCloudTierDefaults: OLLAMA_CLOUD_TIER_DEFAULTS,
      enabledTiers: getEnabledTiers(),
      defaultSpawnTier: getDefaultSpawnTier() };
  }

  r.get('/settings/models', (req, res) => {
    res.json(modelsSettingsState());
  });

  r.post('/settings/models/prefs', async (req, res, next) => {
    try {
      const { onOverage, overageThreshold, conductorCompactWindow,
              tierEnabled, defaultSpawnTier, tierBackend, roleBackend } = req.body ?? {};
      if (typeof onOverage === 'string') await setOnOverageAction(onOverage);
      if (overageThreshold !== undefined) await setOverageThreshold(overageThreshold);
      if (conductorCompactWindow !== undefined) await setConductorCompactWindow(conductorCompactWindow);
      if (tierEnabled !== undefined) {
        if (!tierEnabled || typeof tierEnabled !== 'object' || !isKnownTier(tierEnabled.tier)) {
          return res.status(400).json({ error: 'tierEnabled.tier must be a known capability tier' });
        }
        await setTierEnabled(tierEnabled.tier, !!tierEnabled.enabled);
      }
      if (defaultSpawnTier !== undefined) await setDefaultSpawnTier(defaultSpawnTier);
      if (tierBackend !== undefined) {
        // backend is a {kind, model, window?} record (window meaningful only for
        // a Sonnet 4.x Claude binding) — setTierBackend validates it names a
        // known Claude version or a configured Ollama tag (400 otherwise) and
        // persists the window on the binding.
        if (!tierBackend || typeof tierBackend !== 'object' || !isKnownTier(tierBackend.tier)) {
          return res.status(400).json({ error: 'tierBackend must be {tier, backend:{kind,model}} with a known tier' });
        }
        await setTierBackend(tierBackend.tier, tierBackend.backend);
      }
      if (roleBackend !== undefined) {
        // backend is a tier binding {kind:'tier',tier} or a {kind,model} custom
        // backend — setRoleBinding validates it (400 otherwise).
        if (!roleBackend || typeof roleBackend !== 'object' || !isKnownRole(roleBackend.role)) {
          return res.status(400).json({ error: 'roleBackend must be {role, backend} with a known role' });
        }
        await setRoleBinding(roleBackend.role, roleBackend.backend);
      }
      // Bidirectional on-demand re-evaluation: a save that touched the overage action
      // or threshold should take effect on whatever is happening right now, not wait
      // for the next ~60s poll tick (lower threshold) or the resume deadline, which
      // can be hours away (raised/disabled threshold). Best-effort only — the setting
      // itself is already persisted above regardless of outcome here.
      try {
        if (instances && (onOverage !== undefined || overageThreshold !== undefined)) {
          await instances._usageMonitor.forceTick(); // stop direction: lower threshold trips now
          instances.reevaluateOverageResumes();      // release direction: raised/disabled threshold resumes now
        }
      } catch { /* best-effort re-evaluation */ }
      res.json(modelsSettingsState());
    } catch (e) { next(e); }
  });

  // Custom (Ollama-served) models. Add runs a reachability + model preflight
  // (GET localhost:11434/api/version + /api/tags) so a bad tag fails fast with a
  // clear message instead of a silent `ollama launch` failure at spawn.
  r.post('/settings/models/custom', async (req, res, next) => {
    try {
      const { label, model, contextWindow } = req.body ?? {};
      if (typeof label !== 'string' || !label.trim() || typeof model !== 'string' || !model.trim()) {
        return res.status(400).json({ error: 'label and model (ollama tag) are required' });
      }
      // Optional native context window (raw tokens). Validated before the
      // preflight so a bad value fails fast without a live Ollama. Blank/omitted
      // is fine — the model then falls back to the 200k default.
      if (contextWindow !== undefined && contextWindow !== null && contextWindow !== '') {
        const cw = Number(contextWindow);
        if (!Number.isFinite(cw) || cw <= 0) {
          return res.status(400).json({ error: 'contextWindow must be a positive number of tokens' });
        }
      }
      const pre = await preflightOllamaBackend({ model });
      if (!pre.ok) return res.status(400).json({ error: pre.error });
      const rec = await addCustomBackend({ label, model, contextWindow });
      res.status(201).json({ ...modelsSettingsState(), added: rec });
    } catch (e) { next(e); }
  });

  // Remove by tag (the identity); `:model` is URL-encoded (tags contain ':').
  r.delete('/settings/models/custom/:model', async (req, res, next) => {
    try {
      const ok = await removeCustomBackend(req.params.model);
      if (!ok) return res.status(404).json({ error: 'custom model not found' });
      res.json(modelsSettingsState());
    } catch (e) { next(e); }
  });

  // Text-to-speech: the conversation's 🔊 button (and auto-speak) POSTs the
  // assistant's text here; the server runs Piper locally and streams the
  // synthesized audio back sentence-by-sentence. /status drives the button's
  // visibility — the piper venv + the active voice must be present.
  r.get('/tts/status', async (req, res, next) => {
    try {
      const available = await ttsAvailable();
      res.json({ available });
    } catch (e) { next(e); }
  });

  // Streaming synthesis. Body is the raw text (route-scoped text parser so the
  // global 1 MB JSON limit doesn't apply). The response body is a sequence of
  // [4-byte LE length][WAV] frames, one per sentence, flushed as Piper yields
  // them so the client can start playing the first sentence immediately.
  r.post('/tts', express.text({ type: '*/*', limit: '256kb' }), async (req, res, next) => {
    try {
      if (!(await ttsAvailable())) {
        throw Object.assign(new Error('piper not installed — run bin/install-piper.sh'), { statusCode: 503 });
      }
      const text = typeof req.body === 'string' ? req.body : '';
      const child = synthesize(text); // throws 400 on empty text
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');

      let errBuf = '';
      child.stderr.on('data', (b) => { errBuf += b.toString(); });
      child.stdout.pipe(res);
      child.on('error', (err) => {
        if (!res.headersSent) res.status(500);
        res.end();
        void err;
      });
      child.on('close', (code) => {
        if (code !== 0 && !res.writableEnded) {
          // Piper failed mid-stream; nothing useful to send as a body now.
          res.end();
        }
        void errBuf;
      });
      // If the client disconnects, stop synthesizing.
      res.on('close', () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } });
    } catch (e) { next(e); }
  });

  // Settings → TTS group. Reports the curated voice catalog (with per-voice
  // on-disk presence), the active voice, the auto-speak/rate prefs, and lets
  // the UI switch voices / kick off an install of piper + a chosen voice.
  const tts = mountInstallableCatalog(r, {
    prefix: 'tts',
    itemKey: 'voice',
    catalog: TTS_VOICES,
    pathForName: voicePathForName,
    isKnown: isKnownVoice,
    getActive: getTtsVoice,
    setActive: setTtsVoice,
    defaultName: DEFAULT_VOICE,
    available: ttsAvailable,
    installer: ttsInstall,
    extraState: () => ({ enabled: getTtsEnabled(), rate: getTtsRate() }),
  });

  // Persist the auto-speak toggle and/or playback rate.
  r.post('/settings/tts/prefs', async (req, res, next) => {
    try {
      if (req.body?.enabled !== undefined) await setTtsEnabled(req.body.enabled);
      if (req.body?.rate !== undefined) await setTtsRate(req.body.rate);
      res.json(await tts.state());
    } catch (e) { next(e); }
  });

  // Settings → Conventions → Workspace block. code-conductor fully owns the
  // projects-root CLAUDE.md (the file every project imports via `@../CLAUDE.md`),
  // composed from an always-on core + toggleable conventions. Every mutation
  // regenerates that file so it takes effect immediately.
  r.get('/settings/conventions/workspace', async (req, res, next) => {
    try {
      const [conventions, enabled] = await Promise.all([getWorkspaceConventionsCatalog(), getWorkspaceSelection()]);
      res.json({ core: WORKSPACE_CORE_META, conventions, enabled });
    } catch (e) { next(e); }
  });

  // Literal /selection must precede the /:slug route below so it isn't
  // swallowed as a slug.
  r.put('/settings/conventions/workspace/selection', async (req, res, next) => {
    try {
      const { enabled } = req.body ?? {};
      const saved = await setWorkspaceSelection(enabled);
      await ensureRootClaudeMd();
      res.json({ enabled: saved });
    } catch (e) { next(e); }
  });

  r.post('/settings/conventions/workspace', async (req, res, next) => {
    try {
      const { slug, name, description, body } = req.body ?? {};
      const convention = await addWorkspaceConvention({ slug, name, description, body });
      await ensureRootClaudeMd();
      res.status(201).json({ convention });
    } catch (e) { next(e); }
  });

  r.put('/settings/conventions/workspace/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const { name, description, body } = req.body ?? {};
      const convention = await updateWorkspaceConvention(slug, { name, description, body });
      await ensureRootClaudeMd();
      res.json({ convention });
    } catch (e) { next(e); }
  });

  r.delete('/settings/conventions/workspace/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const result = await deleteWorkspaceConvention(slug);
      await ensureRootClaudeMd();
      res.json(result);
    } catch (e) { next(e); }
  });

  // Settings → Conventions → Project block — catalog read + custom CRUD.
  // Selected per project at creation (snapshotted into the new project's
  // CLAUDE.md); no global selection, no live regeneration.
  r.get('/settings/conventions/project', async (req, res, next) => {
    try { res.json({ conventions: await getProjectConventionsCatalog() }); } catch (e) { next(e); }
  });

  r.post('/settings/conventions/project', async (req, res, next) => {
    try {
      const { slug, name, description, body } = req.body ?? {};
      const convention = await addProjectConvention({ slug, name, description, body });
      res.status(201).json({ convention });
    } catch (e) { next(e); }
  });

  r.put('/settings/conventions/project/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const { name, description, body } = req.body ?? {};
      const convention = await updateProjectConvention(slug, { name, description, body });
      res.json({ convention });
    } catch (e) { next(e); }
  });

  r.delete('/settings/conventions/project/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const result = await deleteProjectConvention(slug);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Settings → Conventions → Conductor block — global (singleton conductor)
  // selection + custom-convention CRUD. Every mutation regenerates
  // .conduct/CONDUCT.md so the next-spawned conductor session picks up the change.
  r.get('/settings/conventions/conductor', async (req, res, next) => {
    try {
      const [conventions, enabled] = await Promise.all([getConductorConventionsCatalog(), getConductorSelection()]);
      res.json({ core: CONDUCT_CORE_META, conventions, enabled });
    } catch (e) { next(e); }
  });

  // Literal /selection must precede the /:slug route below so it isn't
  // swallowed as a slug.
  r.put('/settings/conventions/conductor/selection', async (req, res, next) => {
    try {
      const { enabled } = req.body ?? {};
      const saved = await setConductorSelection(enabled);
      await ensureConductProject();
      res.json({ enabled: saved });
    } catch (e) { next(e); }
  });

  r.post('/settings/conventions/conductor', async (req, res, next) => {
    try {
      const { slug, name, description, body } = req.body ?? {};
      const convention = await addConductorConvention({ slug, name, description, body });
      await ensureConductProject();
      res.status(201).json({ convention });
    } catch (e) { next(e); }
  });

  r.put('/settings/conventions/conductor/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const { name, description, body } = req.body ?? {};
      const convention = await updateConductorConvention(slug, { name, description, body });
      await ensureConductProject();
      res.json({ convention });
    } catch (e) { next(e); }
  });

  r.delete('/settings/conventions/conductor/:slug', async (req, res, next) => {
    try {
      const { slug } = req.params;
      const result = await deleteConductorConvention(slug);
      await ensureConductProject();
      res.json(result);
    } catch (e) { next(e); }
  });

  // Account-level usage from the Anthropic OAuth endpoint. Cached server-side
  // for 180 s. allowStale lets this route serve the last retained payload
  // (with stale: true) when a fresh fetch isn't available, instead of
  // blanking the chip — see src/accountUsage.js. Returns
  // { usage: <data>|null, stale, fetchedAt } — never exposes the raw token.
  r.get('/usage', async (req, res, next) => {
    try {
      const result = await getAccountUsage({ allowStale: true });
      if (!result) return res.json({ usage: null, stale: false, fetchedAt: null });
      res.json({ usage: result.data, stale: result.stale, fetchedAt: result.fetchedAt });
    } catch (e) { next(e); }
  });

  r.get('/costs/summary', async (req, res, next) => {
    try { res.json(await getCostSummary()); } catch (e) { next(e); }
  });

  r.get('/costs/session/:sessionId', async (req, res, next) => {
    try { res.json(await getSessionStats(req.params.sessionId)); } catch (e) { next(e); }
  });

  r.use((err, req, res, _next) => {
    const status = err.statusCode ?? 500;
    res.status(status).json({ error: err.message ?? 'internal error' });
  });

  return r;
}
