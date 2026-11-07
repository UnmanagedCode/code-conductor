// The event log's writer and reader (src/eventLog.ts): the envelope every row
// carries, line order as the only order, one write per append, the lease that
// decides whether a row may land, and the reader's tolerance of torn lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsSync, { promises as fs } from 'node:fs';
import path from 'node:path';
import { createEventLog, eventLogFile, readEventLog } from '../src/eventLog.ts';
import { mkdtemp } from './tmpRegistry.mjs';
import { OPEN_LEASE } from './playbook-fixtures.mjs';

async function rig({ lease = OPEN_LEASE, ...hooks } = {}) {
  const dir = await mkdtemp('cc-evlog-');
  const file = path.join(dir, 'store', 'events.jsonl');
  const log = createEventLog({ file: () => file, lease, ...hooks });
  const lines = async () => {
    try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  return { dir, file, log, lines };
}

// Capture console[method] calls for the duration of `fn`.
async function capture(methods, fn) {
  const out = Object.fromEntries(methods.map(m => [m, []]));
  const orig = Object.fromEntries(methods.map(m => [m, console[m]]));
  for (const m of methods) console[m] = (...a) => { out[m].push(a.join(' ')); };
  try { await fn(); } finally { for (const m of methods) console[m] = orig[m]; }
  return out;
}

const call = (subject, extra = {}) => ({ kind: 'call', actor: { type: 'conductor', sessionId: 'c1' }, subject, tool: 'send_prompt', outcome: 'ok', ...extra });

test('eventLogFile() is resolved per call under the current PROJECTS_ROOT, never at module load', async () => {
  const prev = process.env.PROJECTS_ROOT;
  try {
    const a = await mkdtemp('cc-evlog-root-a-');
    const b = await mkdtemp('cc-evlog-root-b-');
    process.env.PROJECTS_ROOT = a;
    const fa = eventLogFile();
    process.env.PROJECTS_ROOT = b;
    const fb = eventLogFile();
    assert.equal(path.basename(fa), 'events.jsonl');
    assert.ok(fa.startsWith(a) && fb.startsWith(b), `${fa} / ${fb}`);
  } finally {
    if (prev === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = prev;
  }
});

test('every written row carries the envelope in fixed key order — v, ts, kind, actor, subject — with no seq and no null/undefined', async () => {
  const r = await rig();
  await r.log.append(call('w1', { forward: undefined }));
  await r.log.append({ kind: 'session', actor: { type: 'system' }, subject: 'w1', event: 'exit', cause: 'exited' });
  // The single subject exception: a spawn_instance call that produced no session.
  await r.log.append({ kind: 'call', actor: { type: 'conductor', sessionId: 'c1' }, tool: 'spawn_instance', outcome: 'refused', refusal: { code: 'X', reason: 'y' } });
  const lines = await r.lines();
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(!line.includes('null'), line);
    const row = JSON.parse(line);
    assert.equal(row.v, 1);
    assert.equal(typeof row.ts, 'string');
    assert.ok(!Number.isNaN(Date.parse(row.ts)));
    assert.equal('seq' in row, false);
    assert.equal(typeof row.actor?.type, 'string');
    for (const [k, v] of Object.entries(row)) assert.notEqual(v, undefined, k);
  }
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).slice(0, 5), ['v', 'ts', 'kind', 'actor', 'subject']);
  assert.deepEqual(Object.keys(JSON.parse(lines[1])).slice(0, 5), ['v', 'ts', 'kind', 'actor', 'subject']);
  assert.equal('forward' in JSON.parse(lines[0]), false, 'an unset optional key is omitted');
  assert.deepEqual(Object.keys(JSON.parse(lines[2])).slice(0, 4), ['v', 'ts', 'kind', 'actor']);
  assert.equal('subject' in JSON.parse(lines[2]), false);
});

test('concurrent appends land in call order, and a thunk sees every earlier row already written', async () => {
  const written = [];
  const r = await rig({ onWritten: row => written.push(row.subject) });
  const seenByThunk = [];
  const ps = [
    r.log.append(call('a')),
    r.log.append(() => { seenByThunk.push([...written]); return call('b'); }),
    r.log.append(call('c')),
    r.log.append(() => null), // a thunk returning null writes nothing
    r.log.append([call('d'), call('e')]),
  ];
  await Promise.all(ps);
  assert.deepEqual((await r.lines()).map(l => JSON.parse(l).subject), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(seenByThunk, [['a']]);
  assert.deepEqual(written, ['a', 'b', 'c', 'd', 'e'], 'onWritten runs once per row, in order');
});

test('a row array is ONE write: one appendFileSync call, both lines adjacent, sharing one ts', async () => {
  const r = await rig();
  const orig = fsSync.appendFileSync;
  let calls = 0;
  fsSync.appendFileSync = (...a) => { calls++; return orig.apply(fsSync, a); };
  try {
    await r.log.append([call('x'), { kind: 'session', actor: { type: 'system' }, subject: 'x', event: 'exit', cause: 'exited' }]);
  } finally { fsSync.appendFileSync = orig; }
  assert.equal(calls, 1);
  const rows = (await r.lines()).map(l => JSON.parse(l));
  assert.deepEqual(rows.map(x => x.kind), ['call', 'session']);
  assert.equal(rows[0].ts, rows[1].ts);
});

test('the reader skips a torn line, a non-object, another v and an unknown kind — and reads a missing file as empty without creating it', async () => {
  const r = await rig();
  assert.deepEqual(await readEventLog(r.file), []);
  assert.equal(await r.lines(), null, 'reading created nothing');
  await fs.mkdir(path.dirname(r.file), { recursive: true });
  const good = { v: 1, ts: '2026-11-01T00:00:00Z', kind: 'wake', actor: { type: 'system' }, subject: 'w', recipient: 'c' };
  await fs.writeFile(r.file, [
    JSON.stringify(good),
    '{"v":1,"ts":"2026-11-01T00:00:01Z","kind":"cal', // torn
    '[1,2]',
    JSON.stringify({ ...good, v: 2 }),
    JSON.stringify({ ...good, kind: 'mystery' }),
    JSON.stringify({ ...good, subject: 'w2' }),
  ].join('\n') + '\n');
  const out = await capture(['warn'], async () => {
    assert.deepEqual((await readEventLog(r.file)).map(x => x.subject), ['w', 'w2']);
  });
  assert.equal(out.warn.length, 4, out.warn.join('\n'));
});

test('a refusing lease drops rows without touching the file: one error + onBlocked per episode, a warn per drop, a recovery line when writing resumes', async () => {
  let reason = 'a newer server holds the projects root (generation 9)';
  const blocked = [];
  const r = await rig({ lease: { check: () => reason }, onBlocked: (why, row) => blocked.push([why, row.subject]) });
  const out = await capture(['error', 'warn', 'log'], async () => {
    await r.log.append(call('aaaaaaaa-1111'));
    await r.log.append([call('bbbbbbbb-2222'), call('cccccccc-3333')]);
  });
  assert.equal(await r.lines(), null, 'nothing written, not even the directory\'s file');
  assert.equal(out.error.length, 1);
  assert.match(out.error[0], /generation 9/);
  assert.deepEqual(blocked, [[reason, 'aaaaaaaa-1111']]);
  assert.equal(out.warn.length, 3);
  assert.match(out.warn[1], /dropped call row about bbbbbbbb/);

  reason = null;
  const back = await capture(['error', 'warn', 'log'], async () => { await r.log.append(call('dddddddd')); });
  assert.deepEqual((await r.lines()).map(l => JSON.parse(l).subject), ['dddddddd']);
  assert.equal(back.log.length, 1);
  assert.match(back.log[0], /writing again after dropping 3 rows/);

  // A new episode reports again.
  reason = 'the projects-root lock was released';
  const again = await capture(['error', 'warn', 'log'], async () => { await r.log.append(call('eeeeeeee')); });
  assert.equal(again.error.length, 1);
  assert.equal(blocked.length, 2);
});

test('a failed write warns and does not poison the chain', async () => {
  const r = await rig();
  // A directory where the file should be makes appendFileSync throw EISDIR.
  await fs.mkdir(r.file, { recursive: true });
  const out = await capture(['warn'], async () => { await r.log.append(call('x')); });
  assert.equal(out.warn.length, 1);
  assert.match(out.warn[0], /append failed/);
  await fs.rm(r.file, { recursive: true });
  await r.log.append(call('y'));
  assert.deepEqual((await r.lines()).map(l => JSON.parse(l).subject), ['y']);
});
