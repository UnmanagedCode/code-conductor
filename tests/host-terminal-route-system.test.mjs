// GET /api/terminal AGAINST A NON-LOCAL SYSTEM (src/hostTerminal.ts).
//
// The reference provider, behind the recording provider, is registered as a
// system other than `local`, so every terminal crosses the wire protocol and
// the recording is the evidence of what reached the provider. Runs the shared
// rows of tests/hostTerminalRows.mjs, plus what only a provider pipe has: the
// per-pipe terminal cap, and the platform capability gate.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { flakyLaunch, seedRepo } from './remoteSystem.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { adoptProject } from '../src/projects.ts';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { MAX_TERMINALS_PER_SYSTEM } from '../src/systems/terminal.ts';
import { posixPlatform } from '../src/platform/posix.ts';
import { HOST_TERMINAL_ROWS, connectTerminal, open, refused } from './hostTerminalRows.mjs';

const RECORDING = path.join(import.meta.dirname, 'fixtures', 'recordingProvider.mjs');
const SIZE = { cols: 80, rows: 24 };

describe('GET /api/terminal on a provider system', () => {
  let ctx, home, root, record, env;
  const frames = async () => (await fs.readFile(record, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  before(async () => { ctx = await bootServer(); });
  after(async () => { await ctx.close(); });

  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    root = await fs.realpath(await mkdtemp('cc-host-terminal-sys-'));
    record = path.join(root, 'wire.jsonl');
    await addSystem({ id: 'recbox', label: 'rec', launch: ['node', RECORDING, '--record', record] });
    await addSystem({ id: 'nopty', label: 'nopty', launch: ['node', RECORDING, '--record', path.join(root, 'nopty.jsonl'), '--no-pty'] });
    const tree = await fs.realpath(await seedRepo(path.join(root, 'app')));
    assert.equal((await adoptProject('app', tree, { system: 'recbox' })).ok, true);
    const target = { system: 'recbox', cwd: root };
    env = {
      baseUrl: ctx.baseUrl, cwd: root, target, noPtyTarget: { system: 'nopty', cwd: root },
      forms: [
        { name: 'project', target: { project: 'app' }, cwd: tree },
        { name: 'system + cwd', target, cwd: root },
      ],
      assertNothingOpened: async () => {
        assert.deepEqual((await frames()).filter((f) => f.type === 'exec' && f.pty), [],
          'the provider was sent no pty exec');
      },
    };
  });

  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(root);
    await rmrf(home);
  });

  for (const row of HOST_TERMINAL_ROWS) test(row.name, () => row.fn(env));

  // PINS: the provider pipe's terminal cap is the endpoint's: one past
  // MAX_TERMINALS_PER_SYSTEM is 429 TERMINAL_LIMIT, and closing one admits
  // the next.
  test('one terminal past the per-system cap is 429 TERMINAL_LIMIT; closing one admits the next', async () => {
    const spec = { ...env.target, ...SIZE, argv: ['cat'] };
    const sessions = [];
    try {
      for (let i = 0; i < MAX_TERMINALS_PER_SYSTEM; i++) sessions.push(await open(env.baseUrl, spec));
      const over = await refused(env.baseUrl, spec);
      assert.equal(over.status, 429, JSON.stringify(over.body));
      assert.equal(over.body.code, 'TERMINAL_LIMIT');
      const first = sessions.shift();
      first.ws.close();
      await first.closed();
      // The slot is freed when cc handles the close, which the client's own
      // close event does not order against.
      let next = null;
      const deadline = Date.now() + 5_000;
      while (next === null && Date.now() < deadline) {
        const r = await connectTerminal(env.baseUrl, spec);
        if (r.ws) next = r;
        else assert.equal(r.refused?.body?.code, 'TERMINAL_LIMIT', JSON.stringify(r.refused ?? String(r.error)));
      }
      assert.ok(next, 'a freed slot admits the next terminal');
      sessions.push(next);
    } finally {
      for (const s of sessions) s.ws.close();
      await Promise.all(sessions.map((s) => s.closed().catch(() => {})));
    }
  });

  // PINS: an open the far side fails for transport reasons is 502
  // SYSTEM_UNREACHABLE — a provider dying on the pty exec (ETRANSPORT), or
  // answering it ETIMEDOUT — and one it refuses ENOREMOTE is 502
  // REMOTE_NOT_FOUND: named refusals, never 422 TERMINAL_SPAWN_FAILED.
  test('an open failing ETRANSPORT or ETIMEDOUT is 502 SYSTEM_UNREACHABLE; ENOREMOTE is 502 REMOTE_NOT_FOUND', async () => {
    const MARK = 'cc-terminal-open-marker';
    const argv = ['sh', '-c', `cat # ${MARK}`];
    await addSystem({ id: 'dies', label: 'dies', launch: flakyLaunch({ dieOn: MARK }) });
    await addSystem({ id: 'slow', label: 'slow', launch: flakyLaunch({ errorFrame: MARK, errorCode: 'ETIMEDOUT' }) });
    await addSystem({
      id: 'gone', label: 'gone', launch: flakyLaunch({ errorFrame: MARK, errorCode: 'ENOREMOTE', flags: ['--remote', 't1=/'] }),
    });
    const cases = [
      [{ system: 'dies', cwd: root }, 'SYSTEM_UNREACHABLE'],
      [{ system: 'slow', cwd: root }, 'SYSTEM_UNREACHABLE'],
      [{ system: 'gone', remoteId: 't1', cwd: root }, 'REMOTE_NOT_FOUND'],
    ];
    for (const [target, code] of cases) {
      const r = await refused(env.baseUrl, { ...target, ...SIZE, argv });
      assert.equal(r.status, 502, `${target.system}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, target.system);
      // A failure of the open reads `terminal: …`; a resolution refusal reads
      // `terminal on system '…': …`.
      assert.match(r.body.error, /^terminal: /, `${target.system}: the open failed, not resolution`);
    }
  });

  // PINS: a terminal opened for a handshake the WebSocket server then rejects —
  // a POST carrying upgrade headers, which `ws` answers 405 without ever
  // calling back — is closed: the provider is sent `close` for its id.
  test('a terminal whose upgrade never completes is closed', async () => {
    const spec = encodeURIComponent(JSON.stringify({ ...env.target, ...SIZE, argv: ['cat'] }));
    const { port } = new URL(env.baseUrl);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: `/api/terminal?spec=${spec}`,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('upgrade', () => reject(new Error('the upgrade completed')));
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 405, 'ws refused the handshake');
    let pty = [];
    const until = Date.now() + 5_000;
    for (;;) {
      const all = await frames();
      pty = all.filter((f) => f.type === 'exec' && f.pty).map((f) => f.id);
      if ((pty.length === 1 && all.some((f) => f.type === 'close' && f.id === pty[0])) || Date.now() > until) {
        assert.equal(pty.length, 1, 'the terminal was opened before the handshake');
        assert.ok(all.some((f) => f.type === 'close' && f.id === pty[0]), 'and then closed');
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  });
});

describe('GET /api/terminal with remoteSystems off', () => {
  let ctx, home, root;

  before(async () => {
    ctx = await bootServer({ platform: { ...posixPlatform, capabilities: { remoteSystems: false, fuseUnion: false, voice: false } } });
  });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    root = await fs.realpath(await mkdtemp('cc-host-terminal-off-'));
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(root); await rmrf(home); });

  // PINS: a terminal on a non-local system is refused 501
  // SYSTEMS_UNAVAILABLE, addressed either way — and addressed by system, before
  // the system is resolved, so no provider is launched. (By project, resolving
  // the project comes first, as on POST /api/exec.)
  test('a non-local system is 501 SYSTEMS_UNAVAILABLE; by system, before any provider launches', async () => {
    const record = path.join(root, 'wire.jsonl');
    await addSystem({ id: 'recbox', label: 'rec', launch: ['node', RECORDING, '--record', record] });
    const tree = await seedRepo(path.join(root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: 'recbox' })).ok, true);
    // Registration and adoption launch the provider; their transcript is not
    // the request's.
    disposeSystemHandles();
    await fs.rm(record, { force: true });
    const bySystem = await refused(ctx.baseUrl, { system: 'recbox', cwd: root, ...SIZE, argv: ['cat'] });
    assert.equal(bySystem.status, 501, JSON.stringify(bySystem.body));
    assert.equal(bySystem.body.code, 'SYSTEMS_UNAVAILABLE');
    await assert.rejects(fs.stat(record), { code: 'ENOENT' }, 'no provider was launched');
    const byProject = await refused(ctx.baseUrl, { project: 'app', ...SIZE, argv: ['cat'] });
    assert.equal(byProject.status, 501, JSON.stringify(byProject.body));
    assert.equal(byProject.body.code, 'SYSTEMS_UNAVAILABLE');
    assert.equal((await fs.readFile(record, 'utf8').catch(() => '')).split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).some((f) => f.type === 'exec' && f.pty), false, 'no terminal was opened');
  });
});
