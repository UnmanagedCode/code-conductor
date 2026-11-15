import express from 'express';
import { WebSocket } from 'ws';
import { findSessionLocation } from '../projects.ts';
import { conductorSpawnedProjects } from '../conductorSpawns.ts';
import { pageLineageEvents, retiredLineageSource } from '../lineagePager.ts';
import { applySessionTitle, MAX_TITLE_LEN } from '../sessionTitles.ts';
import { applySessionViewed } from '../sessionViewed.ts';
import { SUMMARY_LENGTHS, type SummaryLength } from '../sessionSummaries.ts';
import {
  getSummaries, setSummary, isArchived, loadSessions, resolveOwner,
} from '../sessionStore.ts';
import { publicIdFor } from '../sessionLineage.ts';
import { generateSummary, askSession, countMessages } from '../summarize.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import { httpError } from '../httpError.ts';
import { intQueryParam, sidParam, sendAttachment, jsonBody, type ServerCtx } from './shared.ts';
import type { ProjectsHintFrame } from '../../shared/wsFrames.ts';

export function mountSessions(r: express.Router, { instances, serverCtx }: { instances?: InstanceManagerLike | null; serverCtx?: ServerCtx | null }): void {
  // Nudge every connected client to re-fetch /api/projects, for a route that
  // changes what it reports outside cc's project, workspace and worktree
  // records (e.g. a session title). Those records signal themselves
  // (src/projectsChanged.ts), so their routes call nothing here.
  function broadcastProjects(): void {
    const wss = serverCtx?.wss;
    if (!wss) return;
    const msg = JSON.stringify({ t: 'projects' } satisfies ProjectsHintFrame);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { /* ignore */ }
      }
    }
  }

  // Locate which project / worktree owns a given sessionId. Used by the
  // frontend's `#session=` anchor restore and a notification click's resume: a refresh that lands on a
  // page anchored to a session whose live instance is gone (server restart,
  // killed instance, etc.) hits this endpoint to find the right cwd to
  // resume into.
  // Set or clear a custom human-readable title for a session. Empty /
  // whitespace-only / null title clears the entry. The new title is
  // capped at MAX_TITLE_LEN. Broadcasts a `projects` hint so sidebars
  // refetch, and pushes the updated summary to any live instance(s)
  // currently attached to this sessionId so the active header chip
  // re-renders without a page reload.
  //
  // 404 for an id no session answers to — no in-memory instance answering to
  // it, no store record, no transcript on disk. The store would otherwise create
  // a base-case record for any non-minted-shaped id, and a mistyped one would
  // join the prefix universe (InstanceManager._refOwners) for good. The checks
  // run cheapest first: the transcript probe (findSessionLocation) can walk
  // every project's places, remote worktree listings included.
  r.put('/sessions/:sessionId/title', async (req, res, next) => {
    try {
      const { sid } = await sidParam(req.params.sessionId);
      const raw = jsonBody(req).title;
      if (raw != null && typeof raw !== 'string') {
        throw httpError(400, 'title must be a string');
      }
      const known = (instances?.idsForSession(sid).length ?? 0) > 0
        || resolveOwner(await loadSessions(), sid) !== null
        || (await findSessionLocation(sid)) !== null;
      if (!known) throw httpError(404, 'session not found');
      const stored = await applySessionTitle(instances, sid, raw ?? '');
      broadcastProjects();
      res.json({ ok: true, sessionId: sid, title: stored, maxLength: MAX_TITLE_LEN });
    } catch (e) { next(e); }
  });

  // The browser marks the turn end it showed the human (web/src/app/viewedMarker.ts).
  // No MCP equivalent, by design: a conductor's reads never count as viewed.
  // The broadcast is the live instances' `turn_marks` event (setTurnMarks).
  r.post('/sessions/:sessionId/viewed', async (req, res, next) => {
    try {
      const { sid } = await sidParam(req.params.sessionId);
      const seq = jsonBody(req).seq;
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
        throw httpError(400, 'seq must be a non-negative integer');
      }
      const known = (instances?.idsForSession(sid).length ?? 0) > 0
        || resolveOwner(await loadSessions(), sid) !== null
        || (await findSessionLocation(sid)) !== null;
      if (!known) throw httpError(404, 'session not found');
      const marks = await applySessionViewed(instances, sid, seq);
      res.json({ ok: true, sessionId: sid, ...marks });
    } catch (e) { next(e); }
  });

  type SessionSummaries = Awaited<ReturnType<typeof getSummaries>>;

  // Build the tier response data object, adding per-tier isStale.
  // currentCount should be pre-fetched (once) and passed in.
  function buildTierData(tiers: SessionSummaries, currentCount: number): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const len of SUMMARY_LENGTHS) {
      const t = tiers[len];
      data[len] = t
        ? { ...t, isStale: currentCount > t.messageCount }
        : null;
    }
    return data;
  }

  // Retrieve all stored summaries for a session, with per-tier staleness.
  // Returns { short, medium, long, title } where each tier is null when absent.
  r.get('/sessions/:sessionId/summary', async (req, res, next) => {
    try {
      // Summaries are a session-level fact: `sid` (a public id or any segment)
      // resolves to its session's record inside the store, so it needs no
      // resolve here — only the transcript read below does.
      const { sid, backing } = await sidParam(req.params.sessionId);
      const tiers = await getSummaries(sid);
      let currentCount = 0;
      const hasTiers = Object.keys(tiers).length > 0;
      if (hasTiers) {
        // `hit.cwd` is where the transcript WAS FOUND, never re-derived from the
        // project's tree — that tree is a path on another machine for a project
        // on a system, where the count would silently be 0 (card 2026-0292).
        const hit = await findSessionLocation(sid);
        if (hit) currentCount = await countMessages(backing, hit.place).catch(() => 0);
      }
      res.json({ ok: true, sessionId: sid, data: buildTierData(tiers, currentCount) });
    } catch (e) { next(e); }
  });

  // Generate (or regenerate) one tier for a session via a one-shot Haiku call.
  // Merges the new tier into the session's existing record without clobbering
  // other tiers. Returns the same full tier data shape as GET so the
  // client can refresh its cache in one round-trip, plus this generation's
  // ephemeral cost (not persisted, not part of GET).
  r.post('/sessions/:sessionId/summary', async (req, res, next) => {
    try {
      const { sid, backing } = await sidParam(req.params.sessionId);
      const length = String(jsonBody(req).length);
      if (!(SUMMARY_LENGTHS as readonly string[]).includes(length)) {
        throw httpError(400, `length must be one of: ${SUMMARY_LENGTHS.join(', ')}`);
      }
      const hit = await findSessionLocation(sid);
      if (!hit) throw httpError(404, 'session not found');
      // ONE 404, not two. The hit's `place` is PROOF the directory holds the
      // file — the probe stat'd it at exactly that coordinate — so the second
      // "resolved to nothing" 404 that used to sit here has no state left to
      // catch. It covered a RE-DERIVATION (getWorktree returning null, or
      // getProject refusing) that could disagree with the probe; nothing
      // re-derives now, and the read below takes the probe's own place rather
      // than rebuilding one.
      // The transcript reads take the backing id; the summary lands on the
      // session `sid` resolves to (see the GET above).
      const place = hit.place;
      const { summary, messageCount, costUsd } = await generateSummary(backing, place, length as SummaryLength);
      await setSummary(sid, length as SummaryLength, { summary, generatedAt: Date.now(), messageCount });
      broadcastProjects();
      // Re-fetch all tiers so the response mirrors the GET shape.
      const tiers = await getSummaries(sid);
      const currentCount = await countMessages(backing, place).catch(() => 0);
      // costUsd is ephemeral: what THIS generation cost. Deliberately not persisted
      // (no field on TierRecord) and absent from the GET response.
      res.json({ ok: true, sessionId: sid, data: buildTierData(tiers, currentCount), costUsd });
    } catch (e) { next(e); }
  });

  // Ask a free-form question about a session via a one-shot Fast-tier call.
  // Stores nothing — no summary record, no broadcast; the answer exists only in
  // this response. A client disconnect aborts the call and kills the child.
  r.post('/sessions/:sessionId/ask', async (req, res, next) => {
    try {
      const { sid, backing } = await sidParam(req.params.sessionId);
      const hit = await findSessionLocation(sid);
      if (!hit) throw httpError(404, 'session not found');
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      const { answer, costUsd, usage } = await askSession(backing, hit.place, jsonBody(req).question, abort.signal);
      res.json({ ok: true, sessionId: sid, answer, costUsd, usage });
    } catch (e) {
      if ((e as { name?: unknown })?.name === 'AbortError') return; // the client is gone
      next(e);
    }
  });

  // Root session → the projects it has ever had a worker spawned into, each with
  // the worktrees those workers ran in (the Conductors lens's idle chips, and
  // the tree's idle project rows and recorded worktree rows on every chip
  // project). Read-only over the session store.
  r.get('/conductors/projects', async (_req, res, next) => {
    try { res.json(await conductorSpawnedProjects()); } catch (e) { next(e); }
  });

  // An ended session's scroll-back, from disk: the same page shape and the same
  // walk into older segments as GET /instances/:id/lineage-events, for a
  // session with no instance (a reopened view). Its cursors are archive indices
  // of the session's own transcripts, unrelated to any instance's ring seqs.
  // Responds { sessionId, events, hasMore, segment, nextBefore, pageSegment,
  // currentSegmentId }; 404 when the session cannot be located.
  r.get('/sessions/:sessionId/lineage-events', async (req, res, next) => {
    try {
      const { sid } = await sidParam(req.params.sessionId);
      const hit = await findSessionLocation(sid);
      if (!hit) throw httpError(404, 'session not found');
      const before = intQueryParam(req.query.before, 'before');
      const limit = intQueryParam(req.query.limit, 'limit') ?? undefined;
      const segment = typeof req.query.segment === 'string' && req.query.segment !== '' ? req.query.segment : null;
      const publicId = await publicIdFor(sid);
      const source = await retiredLineageSource(publicId, hit.place);
      res.json({ sessionId: publicId, ...await pageLineageEvents(source, { segment, before, limit }) });
    } catch (e) { next(e); }
  });

  // A session's attachment, addressed by session rather than instance (an ended
  // pane has no live instance): the files live under the place the session ran
  // in (attachmentsDir), so a deleted worktree's are gone with it — 404.
  r.get('/sessions/:sessionId/attachments/:filename', async (req, res, next) => {
    try {
      const { sid } = await sidParam(req.params.sessionId);
      const hit = await findSessionLocation(sid);
      if (!hit) throw httpError(404, 'session not found');
      await sendAttachment(res, hit.project, hit.worktreeName, req.params.filename);
    } catch (e) { next(e); }
  });

  r.get('/sessions/:sessionId/locate', async (req, res, next) => {
    try {
      const { sid, backing } = await sidParam(req.params.sessionId);
      const hit = await findSessionLocation(sid);
      if (!hit) throw httpError(404, 'session not found');
      // Report archived-ness so the client's `#session=` restore opens an
      // archived session read-only (its jsonl is retained, so locate still 200s)
      // instead of resurrecting it. Deliberate
      // resume-from-archived stays allowed — this only feeds the automatic path.
      //
      // PROJECTED EXPLICITLY, not spread: findSessionLocation also returns the
      // `cwd` it found the transcript at and the full `place` coordinate, both
      // internal — for a project on a system the cwd is a path on ANOTHER
      // machine, and the place names cc's own store. This body is the wire
      // contract and must not grow a field (card 2026-0292).
      res.json({ project: hit.project, worktreeName: hit.worktreeName, archived: await isArchived(backing) });
    } catch (e) { next(e); }
  });
}
