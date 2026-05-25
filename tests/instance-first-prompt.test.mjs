import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// `firstPrompt` is captured on the Instance for use by the sidebar — the
// Temp Sessions subnode synthesizes its rows from live-instance summary
// data only (no jsonl read), so without this the row would forever show
// "(new session)" once a prompt had been sent.

async function setupWithProject(name = 'firstprompt') {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const created = await api(ctx.baseUrl, 'POST', '/api/projects', { name });
  assert.equal(created.status, 201);
  return ctx;
}

test('instance summary firstPrompt is null before any prompt, then captures the first one', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'firstprompt' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle');
    assert.equal(inst.summary().firstPrompt, null, 'null before any prompt');
    assert.equal(r.body.firstPrompt, null, 'null in POST response too');

    inst.prompt('hello world');
    await waitFor(() => inst.firstPrompt === 'hello world');

    const list = await api(baseUrl, 'GET', '/api/instances');
    const me = list.body.find(i => i.id === id);
    assert.equal(me.firstPrompt, 'hello world');
  } finally { await close(); }
});

test('firstPrompt does not change when more prompts are sent', async () => {
  const { baseUrl, instances, close } = await setupWithProject('firstprompt2');
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'firstprompt2' });
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    // prompt() captures firstPrompt synchronously before queueing the
    // turn, so we can assert after the call returns without waiting for
    // the scenario to flow a second turn (it only carries one).
    await inst.prompt('first');
    assert.equal(inst.firstPrompt, 'first');
    await inst.prompt('second');
    assert.equal(inst.firstPrompt, 'first');
  } finally { await close(); }
});

test('firstPrompt is capped at 200 chars (matches readFirstPrompt)', async () => {
  const { baseUrl, instances, close } = await setupWithProject('firstprompt3');
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'firstprompt3' });
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    const long = 'x'.repeat(500);
    inst.prompt(long);
    await waitFor(() => inst.firstPrompt !== null);
    assert.equal(inst.firstPrompt.length, 200);
    assert.equal(inst.firstPrompt, 'x'.repeat(200));
  } finally { await close(); }
});
