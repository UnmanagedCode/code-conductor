// The UI mode, server side (server.ts createServer, src/routes/admin.ts):
// GET /api/health's top-level `uiMode` and `focus`, `capabilities` holding the
// platform flags alone, the launchless replay's create() refusal, and the
// interact-without-focus boot refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, entryStartOptions } from '../server.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { bootServer } from './helpers.mjs';

const health = async (baseUrl) => (await fetch(`${baseUrl}/api/health`)).json();
const spawn = (baseUrl) => fetch(`${baseUrl}/api/instances`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

// Invariant: the mode is argv-only — entryStartOptions reads no UI mode from the
// environment, whatever CC_VIEW_ONLY holds.
test('entryStartOptions carries no UI mode', () => {
  for (const env of [{}, { CC_VIEW_ONLY: '1' }]) {
    const o = entryStartOptions(env);
    assert.equal('viewOnly' in o, false);
    assert.equal('uiMode' in o, false);
  }
});

// Invariant: health always carries the server's `uiMode` as a top-level key,
// `full` by default, and `capabilities` is exactly the platform's flags in
// every mode (no viewOnly, no uiMode inside it).
for (const uiMode of [undefined, 'full', 'view', 'interact']) {
  test(`health advertises uiMode ${uiMode ?? '(default)'} and the bare platform capabilities`, async () => {
    const focus = uiMode === 'interact' ? { sessionId: 'root-1' } : undefined;
    const { baseUrl, close } = await bootServer({ uiMode, focus });
    try {
      const body = await health(baseUrl);
      assert.equal(body.uiMode, uiMode ?? 'full');
      assert.deepEqual(body.capabilities, hostPlatform.capabilities);
    } finally { await close(); }
  });
}

// Invariant: a headless-family server advertises its focus cell on health, live
// (the cell is read per request); an ordinary server's health has no `focus` key.
test('health carries the focus cell, and follows it', async () => {
  const focus = { sessionId: null };
  const { baseUrl, close } = await bootServer({ focus });
  try {
    assert.deepEqual((await health(baseUrl)).focus, { sessionId: null });
    focus.sessionId = 'sess-1';
    assert.deepEqual((await health(baseUrl)).focus, { sessionId: 'sess-1' });
  } finally { await close(); }
});

// Invariant: an ordinary server's health has no `focus` key.
test('health without a focus cell has no focus key', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    assert.equal('focus' in await health(baseUrl), false);
  } finally { await close(); }
});

// Invariant: a launchless server (a --replay under --ui view) refuses session
// creation over REST with the replay code.
test('a launchless server answers POST /api/instances 409 VIEW_REPLAY_NO_LAUNCH', async () => {
  const { baseUrl, close } = await bootServer({ launchless: true, uiMode: 'view', focus: { sessionId: 's' } });
  try {
    const res = await spawn(baseUrl);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'VIEW_REPLAY_NO_LAUNCH');
  } finally { await close(); }
});

// Invariant: `uiMode` and `launchless` are independent: an interact server that
// is not launchless never answers create() with the replay refusal.
test('an interact server that can launch does not refuse with VIEW_REPLAY_NO_LAUNCH', async () => {
  const { baseUrl, close } = await bootServer({ uiMode: 'interact', focus: { sessionId: 's' }, launchless: false });
  try {
    const res = await spawn(baseUrl);
    const body = await res.json().catch(() => ({}));
    assert.notEqual(body.code, 'VIEW_REPLAY_NO_LAUNCH', JSON.stringify(body));
  } finally { await close(); }
});

// Invariant: `interact` without a focus cell is a boot error, so a wrong boot
// fails loudly instead of advertising a mode no session can use.
test('createServer refuses uiMode interact without a focus cell', () => {
  assert.throws(() => createServer({ uiMode: 'interact', withInstances: false }), /--ui interact needs a focused session/);
  assert.throws(() => createServer({ uiMode: 'interact', focus: null, withInstances: false }), /--ui interact needs a focused session/);
});
