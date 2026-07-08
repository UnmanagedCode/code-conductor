// End-to-end (real server, fake CLI) proof for the "🧠 Change model" bug:
// the user reported clicking it does nothing on a session they just resumed
// from the sidebar — one that IS backed by a live CLI process but hasn't
// received its first prompt yet (not a genuine replay-only/non-live view).
//
// Two things are verified against the real src/routes.js + src/wsHub.js +
// src/instances.js code paths (no UI/browser involved — see the plan for
// what that leaves unverified):
//
//   1. Sanity-check for the race diagnosis: a freshly-resumed instance is
//      NOT deterministically absent from GET /api/instances — it appears
//      immediately, with its sessionId and a canMenu-eligible status, before
//      any prompt is sent. This is what public/sessionActions.js's
//      resumeSession() and public/app.js's refreshInstances() see. If this
//      assertion failed, the header bug would need a different root cause
//      than the stale-fetch race described in the plan.
//   2. The 'model' WS message (exactly what header.js's popover sends) is
//      accepted and actually switches inst.model while the instance is
//      still pre-first-prompt live (status 'idle'/'spawning', no prompt
//      sent) — proving the server-side mechanism the button depends on
//      works for this exact scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => {
      try { messages.push(JSON.parse(raw.toString())); }
      catch { messages.push(raw.toString()); }
    });
    ws.once('open', () => resolve({
      ws,
      messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise((r) => { ws.once('close', r); ws.close(); }); },
      wait(predicate, timeout = 4000) {
        return waitFor(() => messages.find(predicate), { timeout });
      },
    }));
    ws.once('error', reject);
  });
}

test('a resumed, not-yet-prompted session appears live in GET /api/instances and accepts a model switch', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });

    // Create + let the CLI settle, then kill it so it can be resumed
    // (create() refuses to resume a session a live process already owns).
    const created = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', model: 'claude-sonnet-4-6',
    });
    assert.equal(created.status, 201);
    const firstId = created.body.id;
    await waitFor(() => ctx.instances.get(firstId).status === 'idle');
    const sessionId = ctx.instances.get(firstId).sessionId;
    assert.ok(sessionId);

    // Give the ORIGINAL session one real turn so it has resumable history —
    // this is what makes it a "historical session" the sidebar can later
    // resume. hasResumableConversation() requires a jsonl with a real
    // user/assistant record; fake-claude only writes our own marker lines
    // (last-prompt/permission-mode), so seed one to mirror what the real CLI
    // would have written (same seeding model-resume.test.mjs uses).
    ctx.instances.get(firstId).prompt('hello');
    await waitFor(() => ctx.instances.get(firstId).status === 'idle');
    const projectPath = path.join(ctx.projectsRoot, 'demo');
    const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
    const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);
    await fs.appendFile(jsonlPath,
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }) + '\n');
    await api(ctx.baseUrl, 'DELETE', `/api/instances/${firstId}`);

    // Resume — mirrors sessionActions.resumeSession()'s POST /api/instances
    // with { resume: sessionId }. No prompt is sent at any point below.
    const resumed = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions', resume: sessionId,
    });
    assert.equal(resumed.status, 201);
    const id = resumed.body.id;

    // The POST response itself already carries the right sessionId — this
    // is what resumeSession()'s `const inst = await r.json()` sees.
    assert.equal(resumed.body.sessionId, sessionId,
      'sessionId must be populated synchronously at resume, before the CLI ever starts');

    // (1) Sanity-check: immediately re-fetch the full list (what
    // refreshInstances() does) and confirm the resumed instance is present
    // — not deterministically missing. Whatever caused the header bug, it
    // is not "the server never lists a freshly-resumed instance."
    const list = await api(ctx.baseUrl, 'GET', '/api/instances');
    const fromList = list.body.find((i) => i.id === id);
    assert.ok(fromList, 'the resumed instance must appear in GET /api/instances immediately, before any prompt');
    assert.equal(fromList.sessionId, sessionId);
    assert.ok(['idle', 'turn', 'spawning'].includes(fromList.status),
      `status '${fromList.status}' must be canMenu-eligible immediately after resume`);

    // No prompt has been sent — this is the exact "live but unprompted" state.
    await waitFor(() => ['idle', 'spawning'].includes(ctx.instances.get(id).status));
    assert.equal(ctx.instances.get(id).status === 'turn', false, 'no turn has run yet');

    // (2) Drive the real 'model' WS message (what header.js's popover sends)
    // against this pre-first-prompt resumed instance.
    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait((m) => m.t === 'snapshot');
    c.send({ t: 'model', id, model: 'claude-opus-4-8', reqId: 'm1' });
    const ack = await c.wait((m) => m.t === 'ack' && m.reqId === 'm1');
    assert.equal(ack.ok, true, 'the model switch must succeed on a live, pre-first-prompt resumed instance');
    assert.equal(ctx.instances.get(id).model, 'claude-opus-4-8');
    await c.close();
  } finally {
    await ctx.close();
  }
});
