import express from 'express';
import {
  loadPlaybooks, loadToolIndex, validatePlaybook, locateValidationError, playbookSource, playbookSummary,
  playbookDetail, governableToolCatalog, userPlaybookIds, SEED_PLAYBOOK_IDS, RESERVED_OVERLAY_ID,
  type Playbook,
} from './playbooks.ts';
import type { PlaybookGate } from './mcp/playbookGate.ts';

// REST read + validate surface for playbook definitions — thin delegations to
// src/playbooks.ts, which owns the loader, the validator and the payload
// builders list_playbooks / describe_playbook render from. Mounted from
// src/routes.ts at /playbooks (⇒ /api/playbooks), inheriting its JSON body
// parser and trailing error middleware. There is no write route: an authoring
// plugin writes the user-overlay file itself (docs/plugins.md).
//
// Ledger state is read ONLY through the gate (tests/playbook-ledger-chokepoint.test.mjs).

function provenance(pb: Playbook) {
  const source = playbookSource(pb);
  return { source, editable: source === 'user' };
}

export function buildPlaybookApi({ playbookGate }: { playbookGate?: PlaybookGate | null } = {}): express.Router {
  const r = express.Router();

  // Live workers bound to `id`, or null when that is unknown. A projection read
  // failure degrades to null with a warning, as GET /api/instances' bindings do.
  async function liveWorkers(id: string): Promise<number | null> {
    if (!playbookGate) return null;
    try {
      const proj = await playbookGate.readProjection();
      let n = 0;
      for (const w of proj.bySession.values()) if (w.playbook === id && playbookGate.isLive(w.sessionId)) n++;
      return n;
    } catch (e) {
      console.warn('playbookApi: playbook projection read failed:', e);
      return null;
    }
  }

  r.get('/', async (_req, res, next) => {
    try {
      const [{ playbooks, errors }, index, user] = await Promise.all([loadPlaybooks(), loadToolIndex(), userPlaybookIds()]);
      res.json({
        playbooks: [...playbooks.values()].map(pb => {
          const { id, name, description, entryStages, spawnableStages } = playbookSummary(pb);
          return { id, name, description, ...provenance(pb), entryStages, spawnableStages };
        }),
        errors,
        governableTools: governableToolCatalog(index),
        // Ids a NEW overlay file collides with. Plugin ids contain `/`, which an
        // overlay id cannot, so they are never taken here.
        takenIds: {
          builtin: [...SEED_PLAYBOOK_IDS].sort(),
          user,
          reserved: [RESERVED_OVERLAY_ID],
        },
      });
    } catch (e) { next(e); }
  });

  // The draft is the body — the same JSON an authoring plugin writes to
  // `<id>.json`. Validated against the draft's OWN id, so the filename-match
  // check never fires; an absent or non-string id is reported by the slug check.
  r.post('/validate', async (req, res, next) => {
    try {
      const draft: unknown = req.body;
      const id = (draft as { id?: unknown } | null)?.id as string;
      const result = validatePlaybook(draft, id, await loadToolIndex());
      if (result.ok) { res.json({ ok: true }); return; }
      res.json({
        ok: false,
        errors: result.errors.map(message => ({ message, ...locateValidationError(message, draft) })),
      });
    } catch (e) { next(e); }
  });

  // A regex route so a plugin id's `/` needs no encoding; Express decodes the
  // capture, so `acme%2Frelease` arrives as `acme/release` too.
  r.get(/^\/(.+)$/, async (req, res, next) => {
    try {
      const id = (req.params as unknown as Record<string, string>)[0];
      const pb = (await loadPlaybooks()).playbooks.get(id);
      if (!pb) { res.status(404).json({ error: `no playbook '${id}'`, code: 'PLAYBOOK_UNKNOWN' }); return; }
      const { name, description, entryStages, stages, transitions } = playbookDetail(pb);
      res.json({
        id, name, description, ...provenance(pb), entryStages, stages, transitions,
        liveWorkers: await liveWorkers(id),
      });
    } catch (e) { next(e); }
  });

  return r;
}
