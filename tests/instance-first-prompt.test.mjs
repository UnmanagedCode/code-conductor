import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { buildForwardFrame } from '../shared/forwardFrame.ts';
import { firstPromptHead } from '../shared/promptPreview.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// One server is shared across the file (booted once below); each test gets a
// fresh PROJECTS_ROOT and the spawned instances are cleared between tests, so
// they stay independent. See tests/helpers.mjs → freshProjectsRoot.
let ctx, baseUrl, instances, home;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

async function setupWithProject(name = 'firstprompt') {
  const created = await api(baseUrl, 'POST', '/api/projects', { name });
  assert.equal(created.status, 201);
  return { baseUrl, instances };
}

// `firstPrompt` is captured on the Instance for use by the sidebar — the
// Temp Sessions subnode synthesizes its rows from live-instance summary
// data only (no jsonl read), so without this the row would forever show
// "(new session)" once a prompt had been sent.

test('instance summary firstPrompt is null before any prompt, then captures the first one', async () => {
  const { baseUrl, instances } = await setupWithProject();
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
});

test('firstPrompt does not change when more prompts are sent', async () => {
  const { baseUrl, instances } = await setupWithProject('firstprompt2');
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
});

test('firstPrompt is capped at 200 chars (matches readFirstPrompt)', async () => {
  const { baseUrl, instances } = await setupWithProject('firstprompt3');
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'firstprompt3' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  const long = 'x'.repeat(500);
  inst.prompt(long);
  await waitFor(() => inst.firstPrompt !== null);
  assert.equal(inst.firstPrompt.length, 200);
  assert.equal(inst.firstPrompt, 'x'.repeat(200));
});

test('a forward frame\'s first prompt is stored as its tail', async () => {
  const { baseUrl, instances } = await setupWithProject('firstprompt4');
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'firstprompt4' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  const frame = buildForwardFrame({ messages: ['x'.repeat(5000)], instruction: 'Review it' });
  inst.prompt(frame);
  await waitFor(() => inst.firstPrompt !== null);
  assert.equal(inst.firstPrompt, firstPromptHead(frame));
  assert.ok(inst.firstPrompt.endsWith('Review it'), inst.firstPrompt);
});

// `displayLabel` is the sidebar's label for the row (sessionLabel,
// shared/promptPreview.ts), read here off GET /api/instances.

async function displayLabelOf(id) {
  const list = await api(baseUrl, 'GET', '/api/instances');
  return list.body.find(i => i.id === id).displayLabel;
}

test('displayLabel is the custom title when one is set', async () => {
  const { baseUrl, instances } = await setupWithProject('label1');
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'label1' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  inst.prompt('some prompt');
  await waitFor(() => inst.firstPrompt !== null);
  inst.setTitle('My review target');
  assert.equal(await displayLabelOf(r.body.id), 'My review target');
});

test('displayLabel of an untitled session is its first prompt, whitespace collapsed', async () => {
  const { baseUrl, instances } = await setupWithProject('label2');
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'label2' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  inst.prompt('fix   the\nbug');
  await waitFor(() => inst.firstPrompt !== null);
  assert.equal(await displayLabelOf(r.body.id), 'fix the bug');
});

test('displayLabel names a forward-frame first prompt by its instruction, not the frame text', async () => {
  const { baseUrl, instances } = await setupWithProject('label3');
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'label3' });
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  inst.prompt(buildForwardFrame({ messages: ['x'.repeat(5000)], instruction: 'Review it\nmore' }));
  await waitFor(() => inst.firstPrompt !== null);
  assert.equal(await displayLabelOf(r.body.id), 'Review it');
});

test('displayLabel of an untitled, unprompted session reads (new session)', async () => {
  const { baseUrl, instances } = await setupWithProject('label4');
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'label4' });
  assert.equal(r.body.displayLabel, '(new session)', 'POST response carries it');
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  assert.equal(await displayLabelOf(r.body.id), '(new session)');
});
