// The headless `stream-json` output (src/headless/stream.ts) and the stdout tap
// it reads (Instance `stdout_line` → InstanceManager `stdout_line`).
//
// The pure section drives the stream against a plain EventEmitter manager fake
// with a call-counting `inRunTree`, fake instance objects and an array sink.
// The bootServer section uses the real tap with in-process fake children: a
// line written to `inst.proc.stdout` is read by the instance's own readline,
// as tests/exit-clears-agent-tasks.test.mjs stages it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, seedSessionJsonl } from './helpers.mjs';
import { labelLine, createHeadlessStream } from '../src/headless/stream.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';

const LABELS = {
  cc_session_id: 's-w', cc_parent_session_id: 's-root', cc_root_session_id: 's-root',
  cc_role: 'worker', cc_project: 'demo', cc_worktree: null,
};
const LABEL_KEYS = Object.keys(LABELS);
const microtask = () => new Promise((r) => queueMicrotask(r));

// ── labelLine ────────────────────────────────────────────────────────────────

// Invariant: a labelled line is valid JSON that keeps every CLI key and adds
// cc's six labels.
test('labelLine: an object line keeps its keys and gains the six labels', () => {
  const out = labelLine('{"type":"assistant","n":1}', LABELS);
  assert.deepEqual(JSON.parse(out), { type: 'assistant', n: 1, ...LABELS });
  assert.ok(out.startsWith('{"type":"assistant","n":1,'), 'the CLI\'s bytes come first, untouched');
});

test('labelLine: an empty object gets no leading comma', () => {
  for (const line of ['{}', '{ }']) assert.deepEqual(JSON.parse(labelLine(line, LABELS)), LABELS, line);
});

test('labelLine: trailing spaces and tabs are dropped and the line still parses', () => {
  const out = labelLine('{"a":1} \t ', LABELS);
  assert.deepEqual(JSON.parse(out), { a: 1, ...LABELS });
  assert.ok(out.endsWith('}'));
});

test('labelLine: a big integer keeps its digits verbatim', () => {
  assert.ok(labelLine('{"n":12345678901234567890}', LABELS).startsWith('{"n":12345678901234567890,'));
});

test('labelLine: anything but a plain object becomes a cc_raw wrapper holding the line', () => {
  for (const line of ['not json', '[1,2]', '"s"', 'null', '42', 'true']) {
    assert.deepEqual(JSON.parse(labelLine(line, LABELS)), { type: 'cc_raw', line, ...LABELS }, line);
  }
});

test('labelLine: a CLI-supplied cc_* key is overridden by cc\'s', () => {
  assert.equal(JSON.parse(labelLine('{"cc_role":"conductor","x":1}', LABELS)).cc_role, 'worker');
});

test('labelLine: every output is a single line', () => {
  for (const line of ['{"a":"x\\ny"}', 'raw', '{}', '[]']) assert.ok(!labelLine(line, LABELS).includes('\n'), line);
});

// ── the stream against a fake manager ────────────────────────────────────────

function fakeManager() {
  const mgr = new EventEmitter();
  mgr.member = () => false;
  mgr.walks = 0;
  mgr.inRunTree = (rootId, inst) => { mgr.walks++; return mgr.member(rootId, inst); };
  mgr.line = (instance, line) => mgr.emit('stdout_line', { instance, line });
  mgr.listening = () => ['stdout_line', 'status', 'subscription_changed'].map((e) => mgr.listenerCount(e));
  return mgr;
}
const inst = (id, over = {}) => ({ id, sessionId: `s-${id}`, parentSessionId: null, project: 'demo', worktree: null, ...over });
const ROOT = inst('root', { project: CONDUCT_PROJECT_NAME });

function streamOn(mgr, { includeWorkers = false, sink, capBytes } = {}) {
  const out = [];
  const fails = [];
  const s = createHeadlessStream({
    instances: mgr, includeWorkers,
    sink: sink ?? { write: (c) => { out.push(c); }, buffered: () => 0 },
    onFail: (m) => fails.push(m),
    ...(capBytes !== undefined ? { capBytes } : {}),
  });
  return { s, out, fails };
}

// Invariant: labels come from the instance, never the line; all six keys are
// always present, a missing parent or worktree as null; `.conduct` sessions
// (the root and section leads) are conductors.
test('labels: the instance\'s identity, with the root\'s session as cc_root_session_id', () => {
  const mgr = fakeManager();
  mgr.member = () => true;
  const { s, out } = streamOn(mgr, { includeWorkers: true });
  s.setRoot(ROOT);
  const lead = inst('lead', { project: CONDUCT_PROJECT_NAME, parentSessionId: 's-root' });
  const wt = inst('wt', { parentSessionId: 's-lead', worktree: { worktreeName: 'feat-x' } });
  const plain = inst('plain', { parentSessionId: 's-root' });
  mgr.line(ROOT, '{"type":"system","session_id":"cli-rotated"}');
  mgr.line(lead, '{}');
  mgr.line(wt, '{}');
  mgr.line(plain, '{}');
  const [r, l, w, p] = out.map((c) => JSON.parse(c));
  assert.deepEqual(r, { type: 'system', session_id: 'cli-rotated', cc_session_id: 's-root', cc_parent_session_id: null, cc_root_session_id: 's-root', cc_role: 'conductor', cc_project: CONDUCT_PROJECT_NAME, cc_worktree: null });
  assert.equal(l.cc_role, 'conductor');
  assert.equal(l.cc_parent_session_id, 's-root');
  assert.deepEqual({ role: w.cc_role, wt: w.cc_worktree, parent: w.cc_parent_session_id, root: w.cc_root_session_id }, { role: 'worker', wt: 'feat-x', parent: 's-lead', root: 's-root' });
  assert.equal(p.cc_worktree, null);
  for (const o of [r, l, w, p]) for (const k of LABEL_KEYS) assert.ok(k in o, k);
});

// Invariant: unlabelled output is verbatim and root-only.
test('root only: the root\'s lines verbatim, non-JSON included; no other session\'s', () => {
  const mgr = fakeManager();
  const { s, out } = streamOn(mgr);
  s.setRoot(ROOT);
  const lines = ['{ "a" : 1.0 }  ', 'not json', '{"t":"\\u00e9"}'];
  mgr.line(ROOT, lines[0]);
  mgr.line(inst('other'), '{"from":"other"}');
  mgr.line(ROOT, lines[1]);
  mgr.line(ROOT, lines[2]);
  assert.deepEqual(out, lines.map((l) => `${l}\n`));
  assert.equal(mgr.walks, 0, 'root-only membership never walks the tree');
});

// Invariant: no early root line is lost.
test('before setRoot: queued lines are flushed in order and filtered at setRoot', () => {
  const mgr = fakeManager();
  const { s, out } = streamOn(mgr);
  mgr.line(ROOT, 'r1');
  mgr.line(inst('other'), 'o1');
  mgr.line(ROOT, 'r2');
  assert.deepEqual(out, [], 'nothing is written before the root is known');
  s.setRoot(ROOT);
  assert.deepEqual(out, ['r1\n', 'r2\n']);
  mgr.line(ROOT, 'r3');
  assert.deepEqual(out, ['r1\n', 'r2\n', 'r3\n']);
});

// Invariant: a session that leaves the tree keeps streaming its late lines.
test('the admitted latch: once in the tree, a session\'s later lines stream even when the walk says no', () => {
  const mgr = fakeManager();
  const { s, out } = streamOn(mgr, { includeWorkers: true });
  s.setRoot(ROOT);
  const w = inst('w');
  mgr.member = () => true;
  mgr.line(w, 'first');
  mgr.member = () => false;
  mgr.line(w, 'second');
  mgr.line(inst('never'), 'nope');
  assert.deepEqual(out.map((c) => JSON.parse(c).line), ['first', 'second']);
});

// Invariant: a busy non-member costs one tree walk per change, and a session
// dispatched into the tree joins it.
test('the rejection cache: one walk per non-member until a status or ownership change', () => {
  for (const event of ['status', 'subscription_changed']) {
    const mgr = fakeManager();
    const { s, out } = streamOn(mgr, { includeWorkers: true });
    s.setRoot(ROOT);
    const x = inst('x');
    for (let i = 0; i < 50; i++) mgr.line(x, `{"i":${i}}`);
    assert.equal(mgr.walks, 1, `${event}: 50 lines, one walk`);
    assert.deepEqual(out, []);
    mgr.member = () => true;
    mgr.line(x, '{"i":50}');
    assert.equal(mgr.walks, 1, `${event}: still cached before the change`);
    mgr.emit(event, event === 'status' ? { id: 'x' } : { targetId: 'x' });
    mgr.line(x, '{"i":51}');
    assert.equal(mgr.walks, 2, `${event}: re-walked after the change`);
    assert.deepEqual(out.map((c) => JSON.parse(c).i), [51]);
  }
});

// Invariant: the cap trips loudly and stops the stream.
test('the cap: over capBytes unflushed, onFail once after a microtask, nothing more written, every listener detached', async () => {
  const mgr = fakeManager();
  const out = [];
  const { s, fails } = streamOn(mgr, { includeWorkers: true, capBytes: 10, sink: { write: (c) => { out.push(c); }, buffered: () => 11 } });
  mgr.member = () => true;
  s.setRoot(ROOT);
  mgr.line(ROOT, '{"a":1}');
  assert.equal(out.length, 1);
  assert.deepEqual(fails, [], 'not called inside the line handler');
  await microtask();
  assert.equal(fails.length, 1);
  assert.match(fails[0], /\b11\b/);
  assert.match(fails[0], /\b10\b/);
  mgr.line(ROOT, '{"a":2}');
  assert.equal(out.length, 1, 'no line after the trip');
  assert.deepEqual(mgr.listening(), [0, 0, 0]);
});

// Invariant: a failing stream never throws into the emitter.
test('a throwing sink: the emit does not throw, onFail once after a microtask, listeners detached', async () => {
  const mgr = fakeManager();
  const { s, fails } = streamOn(mgr, { includeWorkers: true, sink: { write: () => { throw new Error('sink exploded'); }, buffered: () => 0 } });
  mgr.member = () => true;
  s.setRoot(ROOT);
  assert.doesNotThrow(() => mgr.line(ROOT, '{"a":1}'));
  assert.deepEqual(fails, []);
  await microtask();
  assert.deepEqual(fails, ['the headless stream failed: sink exploded']);
  assert.deepEqual(mgr.listening(), [0, 0, 0]);
});

// Invariant: nothing is written after close, and the stream stops listening.
test('close(): no write after it, and every listener detached', () => {
  const mgr = fakeManager();
  const { s, out } = streamOn(mgr, { includeWorkers: true });
  mgr.member = () => true;
  s.setRoot(ROOT);
  assert.deepEqual(mgr.listening(), [1, 1, 1]);
  s.close();
  s.close();
  mgr.line(ROOT, '{}');
  assert.deepEqual(out, []);
  assert.deepEqual(mgr.listening(), [0, 0, 0]);
});

// ── the real tap (bootServer, in-process children) ───────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

async function bootWith(t, projects = ['p']) {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  t.after(() => ctx.close());
  for (const name of projects) {
    const p = await api(ctx.baseUrl, 'POST', '/api/projects', { name });
    assert.equal(p.status, 201, JSON.stringify(p.body));
  }
  return ctx;
}
async function spawnPlain(ctx, project) {
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { persistent: true, project, mode: 'bypassPermissions', model: 'claude-haiku-4-5' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const i = ctx.instances.get(r.body.id);
  await waitFor(() => i.status === 'idle' && i.proc);
  return i;
}
// A frame the instance parses into a UI event, so a test can wait for its read.
const taskFrame = (i, taskId) => JSON.stringify({
  type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `tu-${taskId}`, task_type: 'mcp_task',
  description: 'probe', session_id: i.sessionId,
});
function parsedTasks(i) {
  const seen = new Set();
  i.on('event', (ev) => { if (ev?.kind === 'system' && ev.subtype === 'task_started') seen.add(ev.data?.task_id); });
  return seen;
}

// Invariant (spec 6): with no manager listener the tap emits nothing; with one,
// exactly one {instance, line} per line.
test('tap: silent with no listener; one {instance, line} per line once listened to', async (t) => {
  const ctx = await bootWith(t);
  const i = await spawnPlain(ctx, 'p');
  const emits = [];
  const realEmit = ctx.instances.emit.bind(ctx.instances);
  ctx.instances.emit = (name, ...rest) => { if (name === 'stdout_line') emits.push(rest[0]); return realEmit(name, ...rest); };
  t.after(() => { delete ctx.instances.emit; });
  const seen = parsedTasks(i);
  i.proc.stdout.write(`${taskFrame(i, 'quiet')}\n`);
  await waitFor(() => seen.has('quiet'));
  assert.equal(emits.length, 0, 'no stdout_line emit without a listener');
  const got = [];
  const onLine = (e) => got.push(e);
  ctx.instances.on('stdout_line', onLine);
  t.after(() => ctx.instances.off('stdout_line', onLine));
  const a = taskFrame(i, 'a');
  i.proc.stdout.write(`${a}\nraw line\n`);
  await waitFor(() => got.some((e) => e.line === 'raw line'));
  assert.deepEqual(got.map((e) => [e.instance, e.line]), [[i, a], [i, 'raw line']]);
  assert.equal(emits.length, 2);
});

// Invariant: a listener failure never costs cc its own parse of that line.
test('a failing stream: the instance still parses the line it failed on', async (t) => {
  const ctx = await bootWith(t);
  const i = await spawnPlain(ctx, 'p');
  const fails = [];
  const s = createHeadlessStream({
    instances: ctx.instances, includeWorkers: false,
    sink: { write: () => { throw new Error('sink exploded'); }, buffered: () => 0 },
    onFail: (m) => fails.push(m),
  });
  t.after(() => s.close());
  s.setRoot(i);
  assert.equal(i.activeAgentTaskCount, 0, 'premise');
  i.proc.stdout.write(`${taskFrame(i, 't1')}\n`);
  await waitFor(() => i.activeAgentTaskCount === 1);
  await waitFor(() => fails.length === 1);
  assert.match(fails[0], /sink exploded/);
  assert.equal(ctx.instances.listenerCount('stdout_line'), 0);
});

// Invariant (spec 3, the late-line hazard): root-only output is the root CLI's
// stdout byte for byte, across a /clear-style init and a respawn, including a
// line the old launch delivers after the respawn.
test('root only: every root line verbatim across a session_id change, a respawn and a late old-launch line', async (t) => {
  const ctx = await bootWith(t);
  const i = await spawnPlain(ctx, 'p');
  const out = [];
  const s = createHeadlessStream({ instances: ctx.instances, includeWorkers: false, sink: { write: (c) => { out.push(c); }, buffered: () => 0 }, onFail: () => {} });
  t.after(() => s.close());
  s.setRoot(i);
  // Everything the tap relays for this instance, independently of the stream.
  const tapped = [];
  const onLine = (e) => { if (e.instance === i) tapped.push(e.line); };
  ctx.instances.on('stdout_line', onLine);
  t.after(() => ctx.instances.off('stdout_line', onLine));

  const odd = ['{ "spaced" :  true }  ', '{"n":1.0}', '{"t":"\\u00e9 é"}', 'not json at all'];
  const old = i.proc;
  t.after(() => old.kill('SIGKILL'));
  const seen = parsedTasks(i);
  for (const l of odd) old.stdout.write(`${l}\n`);
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a-different-cli-session', tools: [] });
  old.stdout.write(`${init}\n${taskFrame(i, 'first-launch-end')}\n`);
  await waitFor(() => seen.has('first-launch-end'));

  await seedSessionJsonl(i.transcriptPlace, i.backingSessionId);
  old.emit('exit', null, 'SIGKILL');
  await waitFor(() => i.status === 'crashed' && !i.proc);
  await ctx.instances.respawn(i.id);
  await waitFor(() => i.status === 'idle' && i.proc && i.proc !== old);
  const fresh = ['{"second":"launch"}', 'raw second'];
  for (const l of fresh) i.proc.stdout.write(`${l}\n`);
  const late = '{"late":"old launch"}';
  old.stdout.write(`${late}\n`);
  await waitFor(() => out.includes(`${late}\n`) && out.includes('raw second\n'));

  assert.deepEqual(out, tapped.map((l) => `${l}\n`), 'the stream wrote exactly the tapped lines, in order, byte for byte');
  const sub = (want) => {
    let k = 0;
    for (const c of out) if (k < want.length && c === `${want[k]}\n`) k++;
    return k === want.length;
  };
  assert.ok(sub([...odd, init]), 'the first launch\'s lines in its own order');
  assert.ok(sub(fresh), 'the second launch\'s lines in its own order');
  assert.ok(out.includes(`${late}\n`), 'the old launch\'s late line');
});

// Invariant: no foreign output — a session outside the run's tree is never
// streamed, in either mode.
test('a session outside the run tree is not streamed, root-only or --include-workers', async (t) => {
  const ctx = await bootWith(t, ['p', 'other']);
  const root = await spawnPlain(ctx, 'p');
  const other = await spawnPlain(ctx, 'other');
  for (const includeWorkers of [false, true]) {
    const out = [];
    const s = createHeadlessStream({ instances: ctx.instances, includeWorkers, sink: { write: (c) => { out.push(c); }, buffered: () => 0 }, onFail: () => {} });
    s.setRoot(root);
    const seen = parsedTasks(other);
    const id = `foreign-${includeWorkers}`;
    other.proc.stdout.write(`{"foreign":true}\n${taskFrame(other, id)}\n`);
    await waitFor(() => seen.has(id));
    const rootSeen = parsedTasks(root);
    root.proc.stdout.write(`${taskFrame(root, `own-${includeWorkers}`)}\n`);
    await waitFor(() => rootSeen.has(`own-${includeWorkers}`));
    s.close();
    assert.ok(out.length >= 1, `premise: the root's own line streamed (${includeWorkers})`);
    assert.ok(!out.some((c) => c.includes('foreign')), `nothing from the foreign session (includeWorkers ${includeWorkers})`);
  }
});
