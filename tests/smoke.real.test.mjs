// Real-claude smoke test. Skipped by default — opt-in via `RUN_REAL_CLAUDE=1`.
//
// Validates the orchestrator end-to-end against the actually-installed
// `claude` CLI on $PATH. Consumes a tiny number of tokens (a one-word reply),
// uses your real auth, and writes a session jsonl under
// `~/.claude/projects/<encoded-tmp-cwd>/`. The test cleans that file up on
// exit (best effort).
//
// Run with:  RUN_REAL_CLAUDE=1 node tests/run.mjs tests/smoke.real.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, waitFor } from './helpers.mjs';

const ENABLED = !!process.env.RUN_REAL_CLAUDE;
const t = ENABLED ? test : test.skip.bind(test);

t('real claude: spawn → prompt → text_delta + turn_end', async () => {
  const ctx = await bootServer({ useRealClaude: true });
  let sessionId = null;
  let projectPath = null;
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'smoke' });
    projectPath = path.join(ctx.projectsRoot, 'smoke');

    const collected = [];
    ctx.instances.on('event', ({ id, ev }) => collected.push({ id, ev }));

    const created = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'smoke',
      mode: 'bypassPermissions',
    });
    assert.equal(created.status, 201, `unexpected status: ${JSON.stringify(created.body)}`);
    const id = created.body.id;
    sessionId = created.body.sessionId;

    await waitFor(() => ctx.instances.get(id)?.status === 'idle', { timeout: 5_000 });

    // Send a tiny prompt — single-word reply to keep token cost minimal.
    ctx.instances.get(id).prompt('Reply with the single word: pong');

    // Real claude takes a few seconds: startup + API round-trip.
    await waitFor(
      () => collected.some(e => e.id === id && e.ev.kind === 'turn_end'),
      { timeout: 60_000, interval: 100 },
    );

    const mine = collected.filter(e => e.id === id).map(e => e.ev);
    const kinds = mine.map(e => e.kind);

    // Init must arrive (bundled with the response).
    const init = mine.find(e => e.kind === 'system' && e.subtype === 'init');
    assert.ok(init, `no init event seen — kinds: ${kinds.join(',')}`);
    assert.ok(init.data.session_id, 'init carried session_id');

    // At least one text_delta must have streamed.
    assert.ok(kinds.includes('text_delta'), 'no text_delta in stream');

    // The turn must have ended.
    const turn = mine.find(e => e.kind === 'turn_end');
    assert.ok(turn, 'turn_end missing');
    assert.equal(turn.isError, false, `claude returned an error turn: ${JSON.stringify(turn)}`);

    // Stitch the text deltas back together and sanity-check it.
    const reply = mine
      .filter(e => e.kind === 'text_delta')
      .map(e => e.text)
      .join('')
      .trim();
    assert.match(reply.toLowerCase(), /pong/, `expected "pong" in reply, got: ${reply}`);
  } finally {
    await ctx.close();
    // Best-effort cleanup of the persisted session transcript.
    if (sessionId && projectPath) {
      const encoded = projectPath.replaceAll('/', '-');
      const jsonl = path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
      await fs.rm(jsonl, { force: true }).catch(() => {});
      const dir = path.dirname(jsonl);
      await fs.rmdir(dir).catch(() => {});
    }
  }
});
