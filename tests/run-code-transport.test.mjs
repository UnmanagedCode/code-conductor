// How a run_code tools/call answers (src/mcp/callStream.ts, docs/code-mode.md →
// Progress and cancellation): SSE progress for a client that accepts it, and
// both cancellation channels killing the child's process group.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { waitFor } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bootWithSession, spawnIdle, pidAlive } from './codeModeClient.mjs';

let srv, sid, otherSid;

before(async () => {
  ({ srv, sid } = await bootWithSession({ codeModeTiming: { heartbeatMs: 50, minIntervalMs: 10 } }));
  otherSid = (await spawnIdle(srv, 'rc-proj')).sessionId;
});
after(async () => { await srv?.close(); });

const urlFor = (s) => `${srv.baseUrl}/mcp/${encodeURIComponent(s)}?format=text`;
let nextId = 100;
function callBody(id, code, meta) {
  return JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'run_code', arguments: { code }, ...(meta ? { _meta: meta } : {}) },
  });
}
function sseEvents(text) {
  return text.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    assert.ok(lines.includes('event: message'), `every SSE block names its event: ${block.slice(0, 80)}`);
    const data = lines.find(l => l.startsWith('data: '));
    return JSON.parse(data.slice('data: '.length));
  });
}
const SILENT = 'await new Promise(r => setTimeout(r, 400)); return 1';

test('a client that accepts SSE and sends a progressToken gets increasing progress, then the response last', async () => {
  const res = await fetch(urlFor(sid), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: callBody(nextId++, SILENT, { progressToken: 'tok-1' }),
  });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const events = sseEvents(await res.text());
  const progress = events.filter(e => e.method === 'notifications/progress');
  assert.ok(progress.length >= 3, `a 400 ms silent program beat at 50 ms: ${progress.length} progress events`);
  assert.ok(progress.every(e => e.params.progressToken === 'tok-1'));
  const values = progress.map(e => e.params.progress);
  assert.deepEqual(values, [...values].sort((a, b) => a - b));
  assert.equal(new Set(values).size, values.length, 'strictly increasing');
  assert.equal(progress[0].params.message, 'started');
  const last = events.at(-1);
  assert.ok(last.result, 'the final event is the JSON-RPC response');
  assert.equal(JSON.parse(last.result.content[0].text).exitCode, 0);
});

test('log output shows up in a progress message', async () => {
  const res = await fetch(urlFor(sid), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: callBody(nextId++, "console.log('halfway there'); await new Promise(r => setTimeout(r, 300)); return 1", { progressToken: 7 }),
  });
  const progress = sseEvents(await res.text()).filter(e => e.method === 'notifications/progress');
  assert.ok(progress.some(e => /halfway there$/.test(e.params.message)), JSON.stringify(progress.map(e => e.params.message)));
  assert.ok(progress.every(e => e.params.progressToken === 7), 'a numeric token is echoed as a number');
});

test('without a progressToken the stream carries the response and no notifications', async () => {
  const res = await fetch(urlFor(sid), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: callBody(nextId++, SILENT),
  });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const events = sseEvents(await res.text());
  assert.equal(events.length, 1);
  assert.ok(events[0].result);
});

test('a client that accepts only application/json gets one plain JSON response', async () => {
  const res = await fetch(urlFor(sid), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: callBody(nextId++, 'return 1', { progressToken: 'x' }),
  });
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.ok((await res.json()).result);
});

test('a tool that reports no progress answers plain JSON even when SSE is accepted', async () => {
  const res = await fetch(urlFor(sid), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'list_projects', arguments: {}, _meta: { progressToken: 't' } } }),
  });
  assert.match(res.headers.get('content-type'), /^application\/json/);
});

test('a batch is never streamed', async () => {
  const res = await fetch(urlFor(sid), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: `[${callBody(nextId++, 'return 1', { progressToken: 'b' })}]`,
  });
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(Array.isArray(await res.json()), true);
});

// A program that records its pid then never returns (the interval keeps its
// event loop alive; a loop with nothing pending exits NoResult instead).
async function startHung(callerSid, { accept } = {}) {
  const dir = await mkdtemp('cc-rc-cancel-');
  const pidFile = path.join(dir, 'pid');
  const id = nextId++;
  const ac = new AbortController();
  const code = `(await import('node:fs')).writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e6); await new Promise(() => {});`;
  const done = fetch(urlFor(callerSid), {
    method: 'POST', signal: ac.signal,
    headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}) },
    body: callBody(id, code),
  }).then(r => r.json(), e => ({ aborted: e.name }));
  const pid = Number(await waitFor(() => fs.readFile(pidFile, 'utf8')));
  return { id, ac, done, pid };
}
const cancelNotification = (callerSid, requestId) => fetch(urlFor(callerSid), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }),
});

test('notifications/cancelled kills the child and the call answers Cancelled', async () => {
  const run = await startHung(sid);
  assert.ok(pidAlive(run.pid));
  const res = await cancelNotification(sid, run.id);
  assert.equal(res.status, 202);
  await waitFor(() => !pidAlive(run.pid));
  const reply = await run.done;
  const meta = JSON.parse(reply.result.content[0].text);
  assert.equal(meta.error.code, 'RUN_CANCELLED');
  assert.equal(meta.exitCode, null);
});

test('closing the connection kills the child', async () => {
  const run = await startHung(sid);
  run.ac.abort();
  await run.done;
  await waitFor(() => !pidAlive(run.pid));
});

test('a cancel from another session does not touch the call', async () => {
  const run = await startHung(sid);
  await cancelNotification(otherSid, run.id);
  await new Promise(r => setTimeout(r, 150));
  assert.ok(pidAlive(run.pid), 'still running');
  await cancelNotification(sid, run.id);
  await waitFor(() => !pidAlive(run.pid));
  await run.done;
});

test('a cancel for an unknown request id is a harmless notification', async () => {
  const res = await cancelNotification(sid, 999999);
  assert.equal(res.status, 202);
});

test('GET /mcp is still rejected, naming where notifications ride', async () => {
  const res = await fetch(`${srv.baseUrl}/mcp`);
  assert.equal(res.status, 405);
  assert.match((await res.json()).error, /text\/event-stream/);
});
