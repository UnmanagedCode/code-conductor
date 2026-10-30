// THE HOST TERMINAL ROWS: what `GET /api/terminal` (src/hostTerminal.ts, the
// WebSocket a plugin backend opens a terminal through — docs/plugins.md → Host
// terminal) owes its client, run against a `local` target by
// tests/host-terminal-route.test.mjs and against a provider system by
// tests/host-terminal-route-system.test.mjs.
//
// ROWS, NOT TESTS, as tests/terminalBattery.mjs: each entry file registers every
// row with its own `test()` call. A row is `fn(env)`, where `env` is the entry
// file's world:
//   baseUrl            the booted cc
//   cwd                a scratch directory on the target
//   target             spec fields naming that target (system + cwd)
//   forms              [{ name, target, cwd }] — every addressing form the file
//                      checks, with the cwd each must resolve to
//   noPtyTarget        spec fields naming a target without terminals, or null
//   assertNothingOpened()  the wire evidence that no terminal was opened
//                      (the system file's recording); a no-op where there is none
//
// `needsPty` rows open a working terminal; the entry file decides what such a
// row does where the configuration has none (see expectedLocalTerminalRefusal).
//
// Each client here is a node `ws` client, which sends no Origin — the shape of a
// plugin backend.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { alive, patternBytes, settle } from './terminalBattery.mjs';

const WAIT_MS = 10_000;

export const terminalUrl = (baseUrl, spec) =>
  `${baseUrl.replace(/^http/, 'ws')}/api/terminal${spec === undefined ? '' : `?spec=${encodeURIComponent(
    typeof spec === 'string' ? spec : JSON.stringify(spec))}`}`;

// Opens the WebSocket. Resolves with `{ refused: {status, body} }` when cc
// answers the handshake with an HTTP response, `{ error }` when the socket
// fails without one, or a session once the upgrade completes.
export function connectTerminal(baseUrl, spec, { headers } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(terminalUrl(baseUrl, spec), { headers });
    // A latin1 string, appended to: linear in the output, where re-concatenating
    // a Buffer per message is quadratic — and a flooding row reads megabytes.
    let out = '';
    const texts = [];
    const waiters = new Set();
    let closeInfo = null;
    const wake = () => { for (const w of waiters) w(); };
    ws.on('unexpected-response', (_req, res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ refused: { status: res.statusCode, contentType: res.headers['content-type'] ?? null, body } });
        ws.terminate();
      });
    });
    ws.on('error', (error) => resolve({ error }));
    ws.on('message', (data, isBinary) => {
      if (isBinary) out += data.toString('latin1');
      else texts.push(JSON.parse(data.toString('utf8')));
      wake();
    });
    ws.on('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString('utf8'), textsAtClose: texts.length };
      wake();
    });
    const waitFor = (pred, what, ms = WAIT_MS) => new Promise((res, rej) => {
      const check = () => {
        const v = pred();
        if (!v) return;
        waiters.delete(check);
        clearTimeout(timer);
        res(v);
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        rej(new Error(`${what}: not within ${ms}ms; output so far: ${JSON.stringify(out.slice(-400))}`
          + `, texts: ${JSON.stringify(texts)}, close: ${JSON.stringify(closeInfo)}`));
      }, ms);
      waiters.add(check);
      check();
    });
    ws.on('open', () => resolve({
      ws,
      get out() { return out; },
      texts,
      get closeInfo() { return closeInfo; },
      until: (re, ms) => waitFor(() => re.exec(out), `output matching ${re}`, ms),
      closed: (ms) => waitFor(() => closeInfo, 'the socket closing', ms),
      send: (data) => ws.send(data, { binary: true }),
      control: (obj) => ws.send(JSON.stringify(obj)),
    }));
  });
}

// A session, or a failure naming what came back instead.
export async function open(baseUrl, spec, opts) {
  const r = await connectTerminal(baseUrl, spec, opts);
  if (r.ws) return r;
  assert.fail(`the terminal did not open: ${JSON.stringify(r.refused ?? String(r.error))}`);
}

// The refusal, or a failure naming what came back instead.
export async function refused(baseUrl, spec, opts) {
  const r = await connectTerminal(baseUrl, spec, opts);
  if (r.ws) r.ws.terminate();
  assert.ok(r.refused, `expected an HTTP refusal, got ${r.ws ? 'an open socket' : String(r.error)}`);
  return r.refused;
}

const SIZE = { cols: 80, rows: 24 };

export const HOST_TERMINAL_ROWS = [];
{
  const row = (name, fn, { needsPty = true } = {}) => { HOST_TERMINAL_ROWS.push({ name, fn, needsPty }); };

  // PINS: bytes flow both ways as binary messages, and the program's exit is
  // one `exit` text message followed by close 1000.
  row('bytes flow both ways, and the exit message precedes close 1000', async (env) => {
    const s = await open(env.baseUrl, { ...env.target, ...SIZE, argv: ['cat'] });
    s.send(Buffer.from('hi\n'));
    await s.until(/hi\r\nhi\r\n/);
    s.send(Buffer.from([0x04]));
    const c = await s.closed();
    assert.equal(c.code, 1000);
    assert.deepEqual(s.texts, [{ type: 'exit', code: 0, signal: null }], 'exactly one text message: the exit');
    assert.equal(c.textsAtClose, 1, 'the exit message arrived before the close');
  });

  // PINS: a `resize` control message reaches the terminal.
  row('a resize control message resizes the terminal', async (env) => {
    const s = await open(env.baseUrl, { ...env.target, ...SIZE, argv: ['sh', '-c', 'stty size; read x; stty size; read y'] });
    await s.until(/^24 80\r$/m);
    s.control({ type: 'resize', cols: 100, rows: 30 });
    s.send(Buffer.from('\n'));
    await s.until(/^30 100\r$/m);
    s.ws.close();
    await s.closed();
  });

  // PINS: binary 0x03 is ^C — SIGINT to the foreground job.
  row('binary 0x03 interrupts the foreground job', async (env) => {
    const s = await open(env.baseUrl, {
      ...env.target, ...SIZE, argv: ['sh', '-c', 'trap \'echo GOT-SIGINT; exit 7\' INT; echo READY; while :; do sleep 0.05; done'],
    });
    await s.until(/READY/);
    s.send(Buffer.from([0x03]));
    await s.until(/GOT-SIGINT/);
    assert.equal((await s.closed()).code, 1000);
    assert.deepEqual(s.texts, [{ type: 'exit', code: 7, signal: null }]);
  });

  // PINS: a program a signal ended reports the signal and no code, then 1000.
  row('a signal exit reports the signal', async (env) => {
    const s = await open(env.baseUrl, { ...env.target, ...SIZE, argv: ['sh', '-c', 'kill -TERM $$'] });
    assert.equal((await s.closed()).code, 1000);
    assert.deepEqual(s.texts, [{ type: 'exit', code: null, signal: 'SIGTERM' }]);
  });

  // PINS: the client closing its socket closes the terminal — the program is
  // killed.
  row('the client closing the socket kills the program', async (env) => {
    const s = await open(env.baseUrl, { ...env.target, ...SIZE, argv: ['sh', '-c', 'echo PID=$$; exec sleep 300'] });
    const [, pid] = await s.until(/PID=(\d+)/);
    s.ws.close();
    await s.closed();
    assert.ok(await settle(() => !alive(Number(pid))), `the program (${pid}) is gone`);
  });

  // PINS: a text message that is not a valid `resize` is a protocol break:
  // close 1008 naming it, and the program is killed.
  row('a text message that is not a valid control closes 1008 and kills the program', async (env) => {
    for (const bad of ['not json', JSON.stringify({ type: 'resize', cols: 0, rows: 10 }), JSON.stringify({ type: 'paste' })]) {
      const s = await open(env.baseUrl, { ...env.target, ...SIZE, argv: ['sh', '-c', 'echo PID=$$; exec sleep 300'] });
      const [, pid] = await s.until(/PID=(\d+)/);
      s.ws.send(bad);
      const c = await s.closed();
      assert.equal(c.code, 1008, `${bad}: close code`);
      assert.ok(c.reason.length > 0, `${bad}: the reason names the break`);
      assert.ok(await settle(() => !alive(Number(pid))), `${bad}: the program (${pid}) is gone`);
    }
  });

  // PINS: every addressing form the file names resolves through the shared
  // resolver to the cwd it should.
  row('every addressing form opens its terminal in the resolved cwd', async (env) => {
    for (const form of env.forms) {
      const s = await open(env.baseUrl, { ...form.target, ...SIZE, argv: ['pwd'] });
      assert.equal((await s.closed()).code, 1000, form.name);
      assert.equal(s.out.trim(), form.cwd, form.name);
    }
  });

  // PINS: ANY Origin is refused 403 before resolution or open — a same-origin
  // page by this endpoint (ORIGIN_REFUSED, as JSON), a `null` or cross-origin
  // one by the global upgrade guard — and nothing is opened; a client with no
  // Origin, the shape of a plugin backend, is admitted.
  row('any Origin is refused 403 before anything opens; no Origin is admitted', async (env) => {
    const spec = { ...env.target, ...SIZE, argv: ['cat'] };
    const host = new URL(env.baseUrl).host;
    const same = await refused(env.baseUrl, spec, { headers: { Origin: `http://${host}` } });
    assert.equal(same.status, 403);
    assert.equal(same.body.code, 'ORIGIN_REFUSED');
    for (const origin of ['null', 'https://evil.example']) {
      assert.equal((await refused(env.baseUrl, spec, { headers: { Origin: origin } })).status, 403, origin);
    }
    await env.assertNothingOpened();
    const s = await open(env.baseUrl, spec);
    s.ws.close();
    await s.closed();
  });

  // PINS: shape and resolution refusals are JSON HTTP answers before any 101,
  // with stable codes.
  row('shape and resolution refusals are named JSON answers before the upgrade', async (env) => {
    const base = { ...env.target, ...SIZE, argv: ['cat'] };
    const cases = [
      ['no spec', undefined, 400, 'INVALID_ARGUMENT'],
      ['spec is not JSON', '{', 400, 'INVALID_ARGUMENT'],
      ['spec is not an object', '[]', 400, 'INVALID_ARGUMENT'],
      ['an unknown key', { ...base, colour: 'red' }, 400, 'INVALID_ARGUMENT'],
      ['a shell key', { ...base, shell: 'echo hi' }, 400, 'INVALID_ARGUMENT'],
      ['cols of 0', { ...base, cols: 0 }, 400, 'INVALID_ARGUMENT'],
      ['rows missing', { ...env.target, cols: 80, argv: ['cat'] }, 400, 'INVALID_ARGUMENT'],
      ['an empty argv', { ...base, argv: [] }, 400, 'INVALID_ARGUMENT'],
      ['a bad term', { ...base, term: 'x term' }, 400, 'INVALID_ARGUMENT'],
      ['a bad env name', { ...base, env: { 'BAD-NAME': 'x' } }, 400, 'INVALID_ARGUMENT'],
      ['no target', { ...SIZE, argv: ['cat'] }, 400, 'INVALID_ARGUMENT'],
      ['a relative cwd', { ...base, cwd: 'relative' }, 400, 'CWD_NOT_ABSOLUTE'],
      ['an unknown project', { project: 'no-such-project', ...SIZE }, 404, 'PROJECT_UNKNOWN'],
    ];
    for (const [what, spec, status, code] of cases) {
      const r = await refused(env.baseUrl, spec);
      assert.equal(r.status, status, `${what}: ${JSON.stringify(r.body)}`);
      assert.match(r.contentType ?? '', /^application\/json/, `${what}: JSON`);
      assert.equal(r.body.code, code, what);
      assert.equal(typeof r.body.error, 'string', what);
    }
    await env.assertNothingOpened();
  }, { needsPty: false });

  // PINS: a target cc reaches but cannot start the program on is 422
  // TERMINAL_SPAWN_FAILED carrying the errno; a target without terminals is
  // 501 by its own name.
  row('a program or cwd that is not there is 422 with its errno; a target without terminals is 501', async (env) => {
    const missingProgram = await refused(env.baseUrl, { ...env.target, ...SIZE, argv: [path.join(env.cwd, 'no-such-program')] });
    assert.equal(missingProgram.status, 422, JSON.stringify(missingProgram.body));
    assert.equal(missingProgram.body.code, 'TERMINAL_SPAWN_FAILED');
    assert.equal(missingProgram.body.errno, 'ENOENT');
    const missingCwd = await refused(env.baseUrl, { ...env.target, cwd: path.join(env.cwd, 'gone'), ...SIZE, argv: ['true'] });
    assert.equal(missingCwd.status, 422, JSON.stringify(missingCwd.body));
    assert.equal(missingCwd.body.code, 'TERMINAL_SPAWN_FAILED');
    assert.equal(missingCwd.body.errno, 'ENOENT');
    if (env.noPtyTarget) {
      const r = await refused(env.baseUrl, { ...env.noPtyTarget, ...SIZE, argv: ['cat'] });
      assert.equal(r.status, 501, JSON.stringify(r.body));
      assert.equal(r.body.code, 'SYSTEM_NO_PTY');
    }
  });

  // PINS (output backpressure): a client that stops reading stops the
  // program — its line counter stops advancing — and reading again restarts
  // it. The counter is bumped once per 1 KiB line, so it can only stall when
  // writing a line blocks.
  row('a client that stops reading stops the program, and reading again resumes it', async (env) => {
    const counter = path.join(env.cwd, 'count');
    const s = await open(env.baseUrl, {
      ...env.target, ...SIZE,
      argv: ['sh', '-c', `i=0; while :; do i=$((i+1)); echo $i > ${counter}; printf '%1023s\\n' x; done`],
    });
    await s.until(/x\r?\n/);
    s.ws.pause();
    const read = async () => Number((await fs.readFile(counter, 'utf8').catch(() => '')).trim()) || 0;
    // Stalled: unchanged across a quiet interval, found within a bound.
    let stalledAt = -1;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const a = await read();
      await new Promise((r) => setTimeout(r, 300));
      const b = await read();
      if (a === b && a > 0) { stalledAt = b; break; }
    }
    assert.ok(stalledAt > 0, 'the program stalled while the client did not read');
    s.ws.resume();
    assert.ok(await settle(async () => (await read()) > stalledAt + 100, 10_000), 'reading again resumed the program');
    s.ws.close();
    await s.closed();
  });

  // PINS (input backpressure): while the program reads nothing cc stops
  // reading the client — data stays queued on the client — and once the
  // program reads, every byte arrives intact.
  row('cc stops reading a client whose program does not read, and loses nothing', async (env) => {
    const N = 32 * 1024 * 1024;
    const data = patternBytes(N);
    const s = await open(env.baseUrl, {
      ...env.target, ...SIZE,
      argv: ['sh', '-c', `stty raw -echo; echo READY; while [ ! -e GO ]; do sleep 0.01; done; head -c ${N} | sha256sum`],
    });
    await s.until(/READY/);
    const CHUNK = 64 * 1024;
    for (let at = 0; at < N; at += CHUNK) s.send(data.subarray(at, at + CHUNK));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(s.ws.bufferedAmount > 0, `cc stopped reading the client (bufferedAmount ${s.ws.bufferedAmount})`);
    await fs.writeFile(path.join(env.cwd, 'GO'), '');
    const [, digest] = await s.until(/([0-9a-f]{64}) {2}-/, 60_000);
    assert.equal(digest, createHash('sha256').update(data).digest('hex'));
    assert.equal((await s.closed()).code, 1000);
  });
}
