// End-to-end tests for the message-attachment feature. Drives a real
// orchestrator instance against the fake CLI and inspects (a) the
// stream-json payload written to claude's stdin, (b) the on-disk
// attachments dir, and (c) the user_echo UI events emitted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function captureStdin(inst) {
  // The fake CLI is a node child process whose stdin we have full access
  // to via inst.proc.stdin. Tee writes by wrapping the underlying write.
  const lines = [];
  const proc = inst.proc;
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = (chunk, ...rest) => {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      for (const line of text.split('\n')) if (line.trim()) lines.push(line);
    } catch { /* ignore */ }
    return origWrite(chunk, ...rest);
  };
  return lines;
}

function collectEvents(instances) {
  const events = [];
  instances.on('event', ({ id, ev }) => events.push({ id, ev }));
  return events;
}

async function setupWithProject(name = 'demo') {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const created = await api(ctx.baseUrl, 'POST', '/api/projects', { name });
  assert.equal(created.status, 201);
  return ctx;
}

test('prompt() with text-only sends a single text block in the content array', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const stdinLines = captureStdin(instances.get(id));

    await instances.get(id).prompt('hello world');

    const user = stdinLines.map(l => JSON.parse(l)).find(o => o.type === 'user');
    assert.ok(user, 'a user message was written to claude stdin');
    assert.ok(Array.isArray(user.message.content), 'content is an array');
    assert.equal(user.message.content.length, 1);
    assert.deepEqual(user.message.content[0], { type: 'text', text: 'hello world' });
  } finally { await close(); }
});

test('prompt() with an image attachment appends a path-reference text block (no inline vision block) and saves the file', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);
    const stdinLines = captureStdin(inst);
    const events = collectEvents(instances);

    await inst.prompt('look at this', [
      { name: 'tiny.png', mediaType: 'image/png', dataBase64: PNG_1PX },
    ]);

    // stdin: only text blocks — no inline image block. Image bytes are
    // not re-sent on every turn; Claude reads the file path on demand.
    const user = stdinLines.map(l => JSON.parse(l)).find(o => o.type === 'user');
    assert.ok(user, 'user message written');
    assert.equal(user.message.content.length, 2);
    assert.equal(user.message.content[0].type, 'text');
    assert.equal(user.message.content[0].text, 'look at this');
    assert.equal(user.message.content[1].type, 'text');
    assert.match(user.message.content[1].text, /^Attached file: `\.code-conductor\/attachments\/.*tiny\.png`$/);
    // Belt and braces: no `image` content block of any kind.
    assert.ok(!user.message.content.some(b => b.type === 'image'),
      'no inline vision blocks should be sent to the CLI');

    // Disk: file landed under .code-conductor/attachments/.
    const attDir = path.join(inst.cwd, '.code-conductor', 'attachments');
    const entries = await fs.readdir(attDir);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /tiny\.png$/);

    // user_echo: carries image attachment metadata for the live bubble
    // — including dataBase64 so the frontend can render the thumbnail
    // immediately without a round-trip.
    const echo = events.map(e => e.ev).find(e => e.kind === 'user_echo');
    assert.ok(echo, 'user_echo emitted');
    assert.equal(echo.text, 'look at this');
    assert.equal(echo.attachments.length, 1);
    assert.equal(echo.attachments[0].kind, 'image');
    assert.equal(echo.attachments[0].mediaType, 'image/png');
    assert.equal(echo.attachments[0].dataBase64, PNG_1PX);
    assert.match(echo.attachments[0].filename, /tiny\.png$/);
  } finally { await close(); }
});

test('prompt() with a non-image attachment appends a path-reference text block', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);
    const stdinLines = captureStdin(inst);
    const events = collectEvents(instances);

    const dataB64 = Buffer.from('hello,world\n1,2\n', 'utf8').toString('base64');
    await inst.prompt('parse this csv', [
      { name: 'sample.csv', mediaType: 'text/csv', dataBase64: dataB64 },
    ]);

    const user = stdinLines.map(l => JSON.parse(l)).find(o => o.type === 'user');
    assert.equal(user.message.content.length, 2);
    assert.equal(user.message.content[0].type, 'text');
    assert.equal(user.message.content[1].type, 'text');
    assert.match(user.message.content[1].text, /^Attached file: `\.code-conductor\/attachments\/.*sample\.csv`$/);

    // File contents round-trip.
    const attDir = path.join(inst.cwd, '.code-conductor', 'attachments');
    const entries = await fs.readdir(attDir);
    const onDisk = await fs.readFile(path.join(attDir, entries[0]), 'utf8');
    assert.equal(onDisk, 'hello,world\n1,2\n');

    // user_echo carries a file-kind attachment entry.
    const echo = events.map(e => e.ev).find(e => e.kind === 'user_echo');
    assert.equal(echo.attachments[0].kind, 'file');
    assert.match(echo.attachments[0].path, /^\.code-conductor\/attachments\//);
  } finally { await close(); }
});

test('prompt() with no text but one attachment still sends (content array led by the attachment path)', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);
    const stdinLines = captureStdin(inst);

    await inst.prompt('', [
      { name: 'snap.png', mediaType: 'image/png', dataBase64: PNG_1PX },
    ]);

    const user = stdinLines.map(l => JSON.parse(l)).find(o => o.type === 'user');
    assert.equal(user.message.content.length, 1);
    assert.equal(user.message.content[0].type, 'text');
    assert.match(user.message.content[0].text, /^Attached file: `\.code-conductor\/attachments\/.*snap\.png`$/);
  } finally { await close(); }
});

test('prompt() with neither text nor attachments throws', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    await assert.rejects(() => instances.get(id).prompt('', []), /non-empty text or at least one attachment/);
  } finally { await close(); }
});

test('parser replay: text block with `Attached file:` marker becomes an attachment entry', async () => {
  const { Parser } = await import('../src/parser.js');
  const p = new Parser();
  const events = p.handleObject({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'text', text: 'Attached file: `.code-conductor/attachments/2026-01-01T00-00-00-000Z-pic.png`' },
      ],
    },
  });
  const echoes = events.filter(e => e.kind === 'user_echo');
  assert.equal(echoes.length, 1, 'one user_echo per user message');
  assert.equal(echoes[0].text, 'look at this');
  assert.equal(echoes[0].attachments.length, 1);
  assert.equal(echoes[0].attachments[0].kind, 'image');
  assert.equal(echoes[0].attachments[0].filename, '2026-01-01T00-00-00-000Z-pic.png');
  // No dataBase64 — replay path expects the frontend to fetch via the
  // attachments endpoint.
  assert.equal(echoes[0].attachments[0].dataBase64, undefined);
});

test('parser replay: non-image extension yields kind: file', async () => {
  const { Parser } = await import('../src/parser.js');
  const p = new Parser();
  const events = p.handleObject({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'parse this csv' },
        { type: 'text', text: 'Attached file: `.code-conductor/attachments/2026-01-01T00-00-00-000Z-data.csv`' },
      ],
    },
  });
  const echoes = events.filter(e => e.kind === 'user_echo');
  assert.equal(echoes[0].attachments[0].kind, 'file');
  assert.equal(echoes[0].attachments[0].filename, '2026-01-01T00-00-00-000Z-data.csv');
});

test('wsHub prompt: malformed attachment entries are dropped, valid ones are kept', async () => {
  const { baseUrl, instances, wsUrl, close } = await setupWithProject();
  // Lazy-load ws so the test stays self-contained.
  const { WebSocket } = await import('ws');
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);
    const stdinLines = captureStdin(inst);

    const ws = new WebSocket(wsUrl);
    await new Promise(resolve => ws.once('open', resolve));
    ws.send(JSON.stringify({
      t: 'prompt',
      id,
      text: 'hi',
      attachments: [
        { name: 'good.png', mediaType: 'image/png', dataBase64: PNG_1PX },
        { name: 'no-data', mediaType: 'image/png' },           // missing dataBase64
        { mediaType: 'image/png', dataBase64: PNG_1PX },        // missing name
        'not an object',
        null,
      ],
    }));
    await waitFor(() => stdinLines.some(l => l.includes('"type":"user"')));
    ws.close();

    const user = stdinLines.map(l => JSON.parse(l)).find(o => o.type === 'user');
    // text + one Attached-file text block for the single valid image.
    assert.equal(user.message.content.length, 2);
    assert.equal(user.message.content[0].type, 'text');
    assert.equal(user.message.content[0].text, 'hi');
    assert.equal(user.message.content[1].type, 'text');
    assert.match(user.message.content[1].text, /^Attached file: `\.code-conductor\/attachments\/.*good\.png`$/);
  } finally { await close(); }
});

test('GET /api/instances/:id/attachments/:filename serves saved bytes; rejects traversal + missing', async () => {
  const { baseUrl, instances, close } = await setupWithProject();
  try {
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    const inst = instances.get(id);

    // Drop a known file into the per-instance attachments dir.
    const attDir = path.join(inst.cwd, '.code-conductor', 'attachments');
    await fs.mkdir(attDir, { recursive: true });
    const filename = 'stamp-hello.png';
    const bytes = Buffer.from(PNG_1PX, 'base64');
    await fs.writeFile(path.join(attDir, filename), bytes);

    // 200 + bytes round-trip.
    const ok = await fetch(`${baseUrl}/api/instances/${id}/attachments/${filename}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    const got = Buffer.from(await ok.arrayBuffer());
    assert.equal(got.equals(bytes), true);

    // 404 for missing file.
    const miss = await fetch(`${baseUrl}/api/instances/${id}/attachments/does-not-exist.png`);
    assert.equal(miss.status, 404);

    // 400 for path traversal attempts. URL-encoded `..` is decoded by
    // express before our handler sees it, so the basename check rejects it.
    const trav = await fetch(`${baseUrl}/api/instances/${id}/attachments/${encodeURIComponent('../../passwd')}`);
    assert.equal(trav.status, 400);

    // 404 for unknown instance.
    const noinst = await fetch(`${baseUrl}/api/instances/bogus/attachments/${filename}`);
    assert.equal(noinst.status, 404);
  } finally { await close(); }
});
