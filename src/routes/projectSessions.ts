import express from 'express';
import {
  listSessionsForCwd, deleteSessionForCwd, archiveSessionForCwd, listArchivedGroupedByProject, getProject, projectRootPlace, recordedSessionPlace, type TranscriptPlacement,
} from '../projects.ts';
import { listWorktrees, requireWorktree } from '../worktrees.ts';
import { setSegmentArchived } from '../sessionStore.ts';
import type { InstanceLike, InstanceManagerLike } from '../instanceTypes.ts';
import { httpError } from '../httpError.ts';
import { assertValidSid, sidParam } from './shared.ts';

export function mountProjectSessions(r: express.Router, { instances }: { instances?: InstanceManagerLike | null }): void {
  r.get('/projects/:name/sessions', async (req, res, next) => {
    try {
      const proj = await getProject(req.params.name);
      const place = await projectRootPlace(req.params.name, proj.path);
      const normalSids = instances ? instances.normalSessionIdsForPlace(place) : null;
      const sessions = await listSessionsForCwd(place, normalSids, { includeArchived: !!req.query.includeArchived });
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
  async function detachInstancesForSession({ sessionId, force, verb }: { sessionId: string; force: boolean; verb: string }): Promise<void> {
    if (!instances) return;
    const attached = instances.idsForSession(sessionId)
      .map(id => instances.get(id))
      .filter((i): i is InstanceLike => !!i);
    const running = attached.filter(i => i.proc);
    if (running.length > 0 && !force) {
      throw httpError(409,
        `session ${sessionId} is attached to a running instance — ${verb} or pass force=1`,
      );
    }
    if (force) {
      await Promise.all(running.map(i => instances.remove(i.id, { actor: { type: 'human' } }).catch(() => {})));
    }
    const stale = attached.filter(i => !i.proc);
    await Promise.all(stale.map(i => instances.remove(i.id).catch(() => {})));
  }

  async function deleteSessionAtCwd({ place, sessionId, force }: { place: TranscriptPlacement; sessionId: string; force: boolean }): Promise<void> {
    await detachInstancesForSession({ sessionId, force, verb: 'kill it first' });
    const removed = await deleteSessionForCwd(place, sessionId);
    if (!removed) {
      throw httpError(404, `session ${sessionId} not found`);
    }
  }

  r.delete('/projects/:name/sessions/:sid', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      const proj = await getProject(req.params.name);
      const force = req.query.force === '1' || req.query.force === 'true';
      await deleteSessionAtCwd({ place: await projectRootPlace(req.params.name, proj.path), sessionId: sid, force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete('/projects/:name/worktrees/:wt/sessions/:sid', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      const force = req.query.force === '1' || req.query.force === 'true';
      // A removed worktree's session (Settings → Archived lists them) is
      // deleted at the place its record names; any other unknown worktree
      // keeps the WORKTREE_UNKNOWN refusal.
      let place: TranscriptPlacement;
      try {
        const wt = await requireWorktree(req.params.name, req.params.wt);
        place = await projectRootPlace(req.params.name, wt.worktreePath);
      } catch (e) {
        const recorded = (e as { code?: unknown }).code === 'WORKTREE_UNKNOWN'
          ? await recordedSessionPlace(req.params.name, req.params.wt, sid) : null;
        if (!recorded) throw e;
        place = recorded;
      }
      await deleteSessionAtCwd({ place, sessionId: sid, force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Shared by both archive-session endpoints below. Mirrors
  // deleteSessionAtCwd's running-instance guard: a session attached to a
  // live instance refuses with 409 unless ?force=1, which stops the
  // instance first (so the archived session leaves the sidebar cleanly).
  // Unlike delete, this keeps the jsonl — it only flags the transcript's
  // segment archived in the session store.
  async function archiveSessionAtCwd({ place, sessionId, force }: { place: TranscriptPlacement; sessionId: string; force: boolean }): Promise<void> {
    await detachInstancesForSession({ sessionId, force, verb: 'stop it first' });
    const archived = await archiveSessionForCwd(place, sessionId);
    if (!archived) {
      throw httpError(404, `session ${sessionId} not found`);
    }
  }

  r.post('/projects/:name/sessions/:sid/archive', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      const proj = await getProject(req.params.name);
      const force = req.query.force === '1' || req.query.force === 'true';
      await archiveSessionAtCwd({ place: await projectRootPlace(req.params.name, proj.path), sessionId: sid, force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/projects/:name/worktrees/:wt/sessions/:sid/archive', async (req, res, next) => {
    try {
      const sid = String(req.params.sid || '');
      assertValidSid(sid);
      const wt = await requireWorktree(req.params.name, req.params.wt);
      const force = req.query.force === '1' || req.query.force === 'true';
      await archiveSessionAtCwd({ place: await projectRootPlace(req.params.name, wt.worktreePath), sessionId: sid, force });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // All archived sessions, grouped by the project (+ worktree) that owns
  // them — backs the Settings → Archived page.
  r.get('/archived', async (_req, res, next) => {
    try {
      res.json({ groups: await listArchivedGroupedByProject() });
    } catch (e) { next(e); }
  });

  // Restore an archived session to the normal session list.
  // Idempotent — restoring a non-archived session is a no-op.
  r.post('/projects/:name/sessions/:sid/restore', async (req, res, next) => {
    try {
      const { backing } = await sidParam(req.params.sid);
      await setSegmentArchived(backing, false);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/projects/:name/worktrees/:wt/sessions/:sid/restore', async (req, res, next) => {
    try {
      const { backing } = await sidParam(req.params.sid);
      await setSegmentArchived(backing, false);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Per-worktree session list — needed by the new-instance dialog when
  // the user is spawning into an existing worktree (the worktree has its
  // own ~/.claude/projects/<encoded>/ history, distinct from the parent).
  r.get('/projects/:name/worktrees/:wt/sessions', async (req, res, next) => {
    try {
      const wt = await requireWorktree(req.params.name, req.params.wt);
      const wtPlace = await projectRootPlace(req.params.name, wt.worktreePath);
      const normalSids = instances ? instances.normalSessionIdsForPlace(wtPlace) : null;
      const wtSessions = await listSessionsForCwd(wtPlace, normalSids, { includeArchived: !!req.query.includeArchived });
      res.json(wtSessions);
    } catch (e) { next(e); }
  });
}
