import express from 'express';
import { buildRebasePrompt, syncWorktree, worktreeDirtyLines } from '../worktrees.ts';
import { resolveSystem } from '../systems/registry.ts';
import { spawnFromBody } from '../spawnRequest.ts';
import { invalidate } from '../projectsCache.ts';
import { pageInstanceEvents } from '../eventArchive.ts';
import { pageLineageEvents } from '../lineagePager.ts';
import type { CreateInstanceInput, InstanceManagerLike } from '../instanceTypes.ts';
import { httpError } from '../httpError.ts';
import { isSessionId } from '../identifiers.ts';
import type { PlaybookGate } from '../mcp/playbookGate.ts';
import { intQueryParam, sendAttachment, jsonBody } from './shared.ts';
import type { InstanceListRow, InstanceSummary, PlaybookBinding } from '../../shared/wireRows.ts';

export function mountInstances(r: express.Router, { instances, playbookGate }: { instances: InstanceManagerLike; playbookGate?: PlaybookGate | null }): void {
  // An event-log read failure must not break the instance list this drives the
  // whole UI from — it degrades EVERY row's playbook/stage to null instead,
  // with one warning per request rather than one per row. One batch read
  // through the gate's own lookup (never the event log directly — see
  // tests/event-log-chokepoint.test.mjs), which is the SAME gate
  // `createServer` hands the MCP router, so this list reflects whatever the
  // MCP side just wrote.
  async function playbookBindings(sessionIds: unknown[]): Promise<PlaybookBinding[]> {
    if (!playbookGate) return sessionIds.map(() => ({ playbook: null, stage: null }));
    try { return await playbookGate.readBindings(sessionIds); }
    catch (e) {
      console.warn('routes: playbook binding read failed:', e);
      return sessionIds.map(() => ({ playbook: null, stage: null }));
    }
  }

  r.get('/instances', async (_req, res, next) => {
    try {
      const rows = instances.listVisible();
      const bindings = await playbookBindings(rows.map(row => row.sessionId));
      res.json(rows.map((row, i) => ({ ...row, ...bindings[i] })) satisfies Array<InstanceListRow & PlaybookBinding>);
    } catch (e) { next(e); }
  });

  // A lookup, not a list: the tab a pristine conductor's URL is opened in (a
  // reload, another tab) finds it here, since no list payload carries a hidden one.
  r.get('/sessions/:sessionId/pristine', (req, res, next) => {
    try {
      const inst = instances.pristineFor(req.params.sessionId);
      if (!inst) throw httpError(404, 'no live pristine conductor has that session id', { code: 'NOT_PRISTINE' });
      res.json(inst.summary() satisfies InstanceSummary);
    } catch (e) { next(e); }
  });

  r.post('/instances', async (req, res, next) => {
    try { res.status(201).json((await spawnFromBody(instances, jsonBody(req))).summary() satisfies InstanceSummary); }
    catch (e) { next(e); }
  });

  r.post('/instances/:id/respawn', async (req, res, next) => {
    try {
      const inst = await instances.respawn(req.params.id, { actor: { type: 'human' } });
      res.json(inst.summary() satisfies InstanceSummary);
    } catch (e) { next(e); }
  });

  // Paged event history, including events evicted from the capped ring
  // (reconstructed from the session jsonl — see src/eventArchive.ts).
  // `before=<seq>` pages backward (up to `limit` events immediately
  // preceding that seq, oldest-first — echo the
  // response's `nextBefore` cursor back to continue). `after=<seq>` pages
  // forward (first `limit` events with seq > after). Neither → trailing
  // `limit` events. `limit` clamped by `clampLimit` (default `LIMIT_DEFAULT`, max `LIMIT_MAX`). Responds
  // { id, events, hasMore, nextBefore, trimmedBefore, lastSeq }.
  //
  // Both this and lineage-events serve an instance that has left the list
  // (killed, or an exited normal worker) from its frozen pager while the
  // manager still holds one (src/retiredPagers.ts) — the pane that was
  // watching it keeps its cursor space. 404 once that is forgotten.
  r.get('/instances/:id/events', async (req, res, next) => {
    try {
      const inst = instances.pagerFor(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      const before = intQueryParam(req.query.before, 'before');
      const after = intQueryParam(req.query.after, 'after');
      const limit = intQueryParam(req.query.limit, 'limit') ?? undefined;
      const page = await pageInstanceEvents(inst, { before, after, limit });
      res.json({ id: inst.id, ...page });
    } catch (e) { next(e); }
  });

  // The web UI's scroll-back across the session's WHOLE lineage — the live
  // ring, then every earlier backing segment down to `initial` (see
  // src/lineagePager.ts). Backward only: `segment=<id>` names the cursor space
  // a previous page handed out (absent = the live space) and `before=<int>` the
  // cursor in it (absent = that space's newest page). UI-only — no MCP tool
  // reads it. Responds { id, events, hasMore, segment, nextBefore, pageSegment,
  // currentSegmentId }; 400 for a `segment` the walk never hands out.
  r.get('/instances/:id/lineage-events', async (req, res, next) => {
    try {
      const inst = instances.pagerFor(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      const before = intQueryParam(req.query.before, 'before');
      const limit = intQueryParam(req.query.limit, 'limit') ?? undefined;
      // An empty `segment=` is the live space, like an absent one.
      const segment = typeof req.query.segment === 'string' && req.query.segment !== '' ? req.query.segment : null;
      res.json({ id: inst.id, ...await pageLineageEvents(inst, { segment, before, limit }) });
    } catch (e) { next(e); }
  });

  // A renewal divider's `boundary` (its segment_seam segmentId) — the body
  // form of /rewind and /fork taken at a "Context renewed" divider — or null
  // when the body has none. Exclusive with the bubble form's fields.
  const boundaryOf = (body: Record<string, unknown>): string | null => {
    if (body.boundary === undefined) return null;
    if (body.userMessageIndex !== undefined || body.text !== undefined) {
      throw httpError(400, 'boundary cannot be combined with userMessageIndex/text');
    }
    if (!isSessionId(body.boundary)) throw httpError(400, 'boundary must be a segment id');
    return body.boundary;
  };

  // Rewind the active session to before the Nth user prompt (0-indexed
  // among emitted user_echo events — the bubble's `userIndex`; `text` is the
  // bubble's text, and a prompt that doesn't match it is refused before
  // anything is killed or written). Kills the subprocess, truncates the
  // persisted jsonl, broadcasts a snapshot_reset so subscribers clear
  // their conversation, then respawns with --resume so the surviving
  // prefix is replayed. Returns { ok:true, droppedText } so the
  // frontend can prefill the composer with the removed prompt.
  // `{ boundary }` instead undoes the latest renewal at that divider
  // (Instance.rewindAcrossRenewal): `droppedText` is null.
  r.post('/instances/:id/rewind', async (req, res, next) => {
    try {
      const inst = instances.get(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      const body = jsonBody(req);
      const boundary = boundaryOf(body);
      if (boundary !== null) {
        const { droppedText } = await inst.rewindAcrossRenewal(boundary);
        res.json({ ok: true, droppedText });
        return;
      }
      const idx = Number(body.userMessageIndex);
      if (!Number.isInteger(idx) || idx < 0) {
        throw httpError(400, 'userMessageIndex must be a non-negative integer');
      }
      if (typeof body.text !== 'string') throw httpError(400, 'text must be a string');
      const { droppedText } = await inst.rewindToUserMessage(idx, body.text);
      res.json({ ok: true, droppedText });
    } catch (e) { next(e); }
  });

  // Fork the session of the named instance: copy the prefix of its
  // jsonl up to (excluding) the Nth user prompt (the bubble's
  // `userMessageIndex` + `text`, as /rewind takes them) into a new sessionId,
  // leave the original session intact — running, if it is mid-turn — and
  // spawn a fresh instance resuming the forked jsonl. The composer prefill rides the new
  // instance's first `snapshot` frame as `droppedText` (stored via
  // create({prefill}); consumed once in wsHub) — the inline analogue of
  // rewind's `reset_snapshot`. Returns the new instance summary plus
  // { newSessionId, droppedText } (informational; symmetric with /rewind).
  // A body with NEITHER field forks the whole transcript instead (between
  // turns only): nothing is dropped, so `droppedText` is null and no prefill
  // is stored. One field without the other is the bubble form, refused 400.
  // `{ boundary }` forks from before the renewal at that divider
  // (Instance.forkAtRenewal), mid-turn too; `droppedText` is null. Checked
  // first, or that body would read as the anchorless whole-session fork.
  r.post('/instances/:id/fork', async (req, res, next) => {
    try {
      const inst = instances.get(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      const body = jsonBody(req);
      // Every guard, the rewrite-interlock flag's claim/release and the
      // derivation of the respawn arguments live on the instance alongside its
      // rewind/prune siblings; the route only spawns what it hands back.
      let forked: { newSessionId: string; droppedText: string | null; createArgs: CreateInstanceInput };
      const boundary = boundaryOf(body);
      if (boundary !== null) {
        forked = { ...await inst.forkAtRenewal(boundary), droppedText: null };
      } else if (body.userMessageIndex === undefined && body.text === undefined) {
        forked = { ...await inst.forkAtTip(), droppedText: null };
      } else {
        const idx = Number(body.userMessageIndex);
        if (!Number.isInteger(idx) || idx < 0) {
          throw httpError(400, 'userMessageIndex must be a non-negative integer');
        }
        if (typeof body.text !== 'string') throw httpError(400, 'text must be a string');
        forked = await inst.forkAtUserMessage(idx, body.text);
      }
      const { newSessionId, droppedText, createArgs } = forked;
      const newInst = await instances.create({ ...createArgs, actor: { type: 'human' }, launchCause: 'fork' });
      res.status(201).json({
        ok: true,
        newSessionId,
        droppedText,
        instance: newInst.summary(),
      });
    } catch (e) { next(e); }
  });

  // Per-turn analysis backing the Prune dialog's slider + savings readout.
  // Returns every turn's prunable-token count broken down by category, so the
  // client can recompute any slider/tickbox combination locally instead of
  // round-tripping on every drag. Counted over in-context entries only —
  // sidechains and the disk-only `toolUseResult` sidecar are excluded (see
  // sessionPrune.ts). `contextTokens` is the ctx chip's reading, the dialog's
  // percentage baseline; null while the instance holds none.
  r.get('/instances/:id/prune/analysis', async (req, res, next) => {
    try {
      const inst = instances.get(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      if (!inst.backingSessionId) {
        throw httpError(400, 'no sessionId — instance has not yet received a turn');
      }
      const { analyzeSessionForPrune, contextReading } = await import('../sessionPrune.ts');
      const contextTokens = contextReading(inst.lastContextUsage);
      const analysis = await analyzeSessionForPrune({ place: inst.transcriptPlace, sessionId: inst.backingSessionId });
      res.json({ ...analysis, contextTokens });
    } catch (e) { next(e); }
  });

  // Prune the active session: stub tool outputs / oversized tool inputs in the
  // turns before `cutTurnIndex` (and, independently, thinking blocks) into a
  // COPY under a fresh BACKING id (the public sessionId is pinned), archive the
  // original, and respawn this same
  // instance against the pruned file. The session comes back IDLE — unlike
  // renew_session, nothing is seeded as a first turn.
  r.post('/instances/:id/prune', async (req, res, next) => {
    try {
      const inst = instances.get(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      const body = jsonBody(req);
      const cutTurnIndex = Number(body.cutTurnIndex);
      if (!Number.isInteger(cutTurnIndex) || cutTurnIndex < 0) {
        throw httpError(400, 'cutTurnIndex must be a non-negative integer');
      }
      const result = await inst.pruneSession({
        cutTurnIndex,
        pruneThinking: !!body.pruneThinking,
        inputMode: body.inputMode ?? 'truncate',
      });
      res.json({ ok: true, ...result, instance: inst.summary() });
    } catch (e) { next(e); }
  });

  r.delete('/instances/:id', async (req, res, next) => {
    try {
      await instances.remove(req.params.id, { actor: { type: 'human' } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Make a live normal session persistent. 404 on unknown id, 400 when
  // the instance is already persistent (a no-op would be confusing —
  // better to surface the misuse). The summary broadcast that follows the
  // status emit lets the sidebar move the row into its Persistent group.
  r.post('/instances/:id/persist', async (req, res, next) => {
    try {
      const inst = instances.get(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      const summary = await inst.makePersistent();
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

  // Measure the worktree against its parent's baseBranch and land what git
  // can do alone (FF or auto-rebase). Never prompts the agent — a blocked
  // sync comes back as ok:true + action (commit-required | rebase-conflict)
  // carrying the rendered rebasePrompt; POST /rebase-prompt is the separate,
  // explicit dispatch. Works on a dead instance: reporting sync state needs
  // no subprocess.
  r.post('/instances/:id/sync', async (req, res, next) => {
    try {
      const inst = instances.get(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      if (!inst.worktree) throw httpError(400, 'instance is not attached to a worktree');
      const result = await syncWorktree(inst.project, inst.worktree.worktreeName);
      invalidate(inst.project);
      res.json(result);
    } catch (e) { next(e); }
  });

  // The only path in the land flow that starts a worker turn, split out from
  // /sync so that measuring is never also dispatching. The brief is chosen
  // server-side from the worktree's current state, never supplied by the client
  // — and this check is all the state it has: a dispatch can arrive against a
  // worktree that has moved since the sync that blocked (stale tab, a second
  // click, another actor), so neither brief claims anything about an earlier
  // rebase attempt. See buildRebasePrompt.
  r.post('/instances/:id/rebase-prompt', async (req, res, next) => {
    try {
      const inst = instances.get(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      if (!inst.worktree) throw httpError(400, 'instance is not attached to a worktree');
      if (!inst.proc) {
        res.json({
          ok: false, code: 'SESSION_NOT_LIVE',
          reason: 'instance is not running — Resume it before asking the agent to rebase',
        });
        return;
      }
      // A FAILED measurement is not a clean tree. `worktreeDirtyLines` reports
      // {ok:false, lines:[]} when `git status` itself exits non-zero, and the
      // conflict brief tells the agent the tree "should be clean" — so folding
      // the failure into the else-branch would assert something we never
      // measured. Refuse instead, exactly as syncWorktree does for the same
      // git-status failure.
      const dirty = await worktreeDirtyLines(await resolveSystem(inst.project), inst.worktree.worktreePath);
      if (!dirty.ok) {
        res.json({
          ok: false, code: 'WORKTREE_STATUS_FAILED',
          reason: `git status failed inside worktree '${inst.worktree.worktreePath}' — cannot tell the agent what to do`,
        });
        return;
      }
      const blocker = dirty.lines.length > 0 ? 'dirty' : 'conflict';
      // A human clicked it: authored `human` (src/promptAuthor.ts).
      await inst.prompt(buildRebasePrompt(inst.worktree, blocker), [], { annotateIfMidTurn: false, author: 'human' });
      res.json({ ok: true, action: 'rebase-prompt-sent', blocker });
    } catch (e) { next(e); }
  });

  // Serve a previously-saved attachment from the instance's central-
  // store attachments dir. The frontend uses this to populate user-
  // bubble thumbnails on transcript replay (the bytes aren't echoed
  // back via the WS user_echo on a fresh page load because they were
  // never written to the session jsonl).
  r.get('/instances/:id/attachments/:filename', async (req, res, next) => {
    try {
      const inst = instances.get(req.params.id);
      if (!inst) throw httpError(404, 'instance not found');
      await sendAttachment(res, inst.project, inst.worktree?.worktreeName ?? null, req.params.filename);
    } catch (e) { next(e); }
  });
}
