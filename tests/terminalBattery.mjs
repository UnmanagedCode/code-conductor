// THE TERMINAL BATTERY: what `System.openTerminal` owes its caller, run against
// BOTH implementations — LocalSystem by tests/systems-terminal-local.test.mjs and
// ProviderSystem over the protocol by tests/systems-protocol-conformance.test.mjs.
// One battery, because local and remote terminals take the same path and the
// same API, so they owe the same behaviour.
//
// ROWS, NOT TESTS: this file declares none. Each entry file registers every row
// of `TERMINAL_ROWS` with its own `test()` call (`terminalRowTest` builds the
// body), so a row's test id belongs to the `.test.mjs` file that ran it.
//
// Each row opens real terminals running real programs. A row that needs a pid
// to be gone polls `kill(pid, 0)` within a bound rather than sleeping, so it
// assumes the program runs on THIS machine — true of LocalSystem, and of a
// provider that reaches the test process's own filesystem, which is what the
// conformance suite already verifies.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
// Namespace imports, so a constant a row needs that is not exported yet reds
// that row by assertion instead of failing the whole file at link time.
import * as protocol from '../src/systems/protocol.ts';
import * as terminalModule from '../src/systems/terminal.ts';
import { probePtyHelper } from '../src/systems/ptyHost.ts';
import { LOCAL_PROVIDER_ENV, parseProviderLaunch } from '../src/systems/registry.ts';
import { REFERENCE_PROVIDER } from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const WAIT_MS = 10_000;

const probe = await probePtyHelper();

// What a terminal on the `local` handle does under the CURRENT configuration —
// the one `npm run gate:systems` replaces with a provider: null when one opens,
// otherwise the 501 refusal code it owes. Derived from the configuration, never
// from the handle under test: in-process the host's probe decides; over the
// reference provider its `--no-pty` flag and the same probe do; a third-party
// provider's handshake (connect `sys` first) is the only word on it.
export function expectedLocalTerminalRefusal(sys) {
  const spec = process.env[LOCAL_PROVIDER_ENV]?.trim();
  const argv = spec ? parseProviderLaunch(spec) : null;
  if (argv === null) return probe.ok ? null : 'PTY_UNAVAILABLE';
  if (argv.includes(REFERENCE_PROVIDER)) return probe.ok && !argv.includes('--no-pty') ? null : 'SYSTEM_NO_PTY';
  return sys.handshake.capabilities.pty ? null : 'SYSTEM_NO_PTY';
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function settle(pred, ms = 5_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return pred();
}

// `n` bytes covering every byte value, the same on every run (xorshift32).
export function patternBytes(n) {
  const b = Buffer.alloc(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// A program that puts its terminal in raw mode — so every byte reaches it
// unchanged and nothing is echoed — says READY, waits for `gate` (a file in
// its cwd) when one is named, then hashes exactly `n` bytes of input.
const hashInput = (n, gate = null) => ['sh', '-c', 'stty raw -echo; echo READY; '
  + (gate ? `while [ ! -e ${gate} ]; do sleep 0.01; done; ` : '') + `head -c ${n} | sha256sum`];
const DIGEST_RE = /([0-9a-f]{64}) {2}-/;

// One open terminal, its output accumulated and its end awaited.
//   until(re)  — resolves with the match once the output matches, or fails
//                naming the output it had.
//   drains     — how many times `onDrain` has fired; drained() waits for one.
//   ended      — the TerminalEnd, with the output as it stood when onExit fired.
//                BOUNDED each time it is read: a terminal that never ends fails
//                the row by name within WAIT_MS, not at the runner's timeout.
export async function openSession(sys, spec) {
  let out = '';
  let calls = 0;
  let drains = 0;
  const waiters = new Set();
  let endWith;
  const ended = new Promise((r) => { endWith = r; });
  const terminal = await sys.openTerminal(
    { cols: 80, rows: 24, term: 'xterm-256color', ...spec },
    {
      onData(chunk) {
        assert.ok(Buffer.isBuffer(chunk), 'onData is handed bytes');
        calls += 1;
        out += chunk.toString('latin1');
        for (const w of waiters) w();
      },
      onExit(end) { endWith({ end, outAtExit: out }); },
      onDrain() {
        drains += 1;
        for (const w of waiters) w();
      },
    },
  );
  const until = (re, ms = WAIT_MS) => new Promise((resolve, reject) => {
    const check = () => {
      const m = re.exec(out);
      if (!m) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(m);
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`no ${re} within ${ms}ms; output so far: ${JSON.stringify(out.slice(-400))}`));
    }, ms);
    waiters.add(check);
    check();
  });
  const drained = (ms = WAIT_MS) => new Promise((resolve, reject) => {
    const check = () => {
      if (drains === 0) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`no onDrain within ${ms}ms`));
    }, ms);
    waiters.add(check);
    check();
  });
  const boundedEnd = () => {
    let timer;
    return Promise.race([
      ended.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `the terminal did not end (onExit) within ${WAIT_MS}ms; output so far: ${JSON.stringify(out.slice(-400))}`)), WAIT_MS);
      }),
    ]);
  };
  return {
    terminal, until, drained, get ended() { return boundedEnd(); }, get out() { return out; }, get calls() { return calls; },
    get drains() { return drains; },
  };
}

// The body of one row's test. `open(opts)` builds a fresh system —
// `opts.maxTerminals` is the cap — and returns `{ sys, dispose }`. `gate(sys)`
// returns null to run the row, or a skip reason. A row is handed the test
// context too, to skip on what only it can check.
export function terminalRowTest({ fn, opts = {} }, { open, gate = () => null }) {
  return async (t) => {
    const dir = await mkdtemp('cc-terminal-');
    const cwd = await fs.realpath(dir);
    const { sys, dispose } = await open(opts);
    try {
      const reason = gate(sys);
      if (reason !== null) { t.skip(reason); return; }
      await fn(sys, cwd, t);
    } finally {
      await dispose();
      await rmrf(dir);
    }
  };
}

// A process's state letter from /proc (`Z` once it has exited unreaped), or
// null when it is gone or there is no /proc.
async function procState(pid) {
  try { return (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1][0]; }
  catch { return null; }
}

export const TERMINAL_ROWS = [];
{
  const row = (name, fn, opts = {}) => { TERMINAL_ROWS.push({ name, fn, opts }); };

  // PINS: bytes reach the program and its output comes back, and the program's
  // exit is the terminal's end — `^D` on an empty line is EOF to `cat`.
  row('a write reaches the program and its output streams back; ^D ends it', async (sys, cwd) => {
    const s = await openSession(sys, { cwd, argv: ['cat'] });
    s.terminal.write('hello-cat\n');
    // Twice: the terminal's own echo, then cat's copy.
    await s.until(/hello-cat\r\nhello-cat\r\n/);
    s.terminal.write(Buffer.from([0x04]));
    assert.deepEqual((await s.ended).end, { kind: 'exited', code: 0, signal: null });
  });

  // PINS: no argv runs the target user's login shell, which reads and runs
  // commands. `$((6*7))` is computed, so the match is the shell's output and
  // never the terminal echoing what was typed.
  row('no argv runs the login shell', async (sys, cwd) => {
    const s = await openSession(sys, { cwd });
    s.terminal.write('echo MARK_$((6*7)); exit 0\n');
    await s.until(/MARK_42/);
    assert.deepEqual((await s.ended).end, { kind: 'exited', code: 0, signal: null });
  });

  // PINS: `env` is an OVERLAY on the target's environment — PATH survives it —
  // and `term` becomes TERM over an `env.TERM`.
  row('env is added to the environment, and term wins TERM', async (sys, cwd) => {
    const s = await openSession(sys, {
      cwd, term: 'xterm-256color', env: { HISTFILE: path.join(cwd, 'hist'), TERM: 'dumb' },
      argv: ['sh', '-c', 'printf "H=%s T=%s P=%s\\n" "$HISTFILE" "$TERM" "${PATH:+set}"'],
    });
    await s.until(/H=(.*) T=(\S+) P=(\S+)\r\n/);
    const [, h, term, p] = /H=(.*) T=(\S+) P=(\S+)\r\n/.exec(s.out);
    assert.equal(h, path.join(cwd, 'hist'), 'the overlay is in the environment');
    assert.equal(term, 'xterm-256color', '`term` is TERM, over env.TERM');
    assert.equal(p, 'set', 'PATH is still there — the overlay replaced nothing');
    await s.ended;
  });

  // PINS: the program runs IN `cwd`.
  row('the program runs in cwd', async (sys, cwd) => {
    const s = await openSession(sys, { cwd, argv: ['pwd'] });
    const { outAtExit } = await s.ended;
    assert.equal(outAtExit.trim(), cwd);
  });

  // PINS: a cwd that is not there and a program that is not there both REJECT
  // the open with ENOENT, as a SystemError — the target's answer, not a refusal.
  row('a missing cwd or a missing program rejects ENOENT', async (sys, cwd) => {
    const isEnoent = (e) => e.name === 'SystemError' && e.code === 'ENOENT';
    await assert.rejects(openSession(sys, { cwd: path.join(cwd, 'gone'), argv: ['true'] }), isEnoent);
    await assert.rejects(openSession(sys, { cwd, argv: [path.join(cwd, 'no-such-program')] }), isEnoent);
  });

  // PINS: the exit is reported as it happened — a code, or the signal and no code.
  row('the program\'s exit code, or the signal that ended it, is the end', async (sys, cwd) => {
    const a = await openSession(sys, { cwd, argv: ['sh', '-c', 'exit 7'] });
    assert.deepEqual((await a.ended).end, { kind: 'exited', code: 7, signal: null });
    const b = await openSession(sys, { cwd, argv: ['sh', '-c', 'kill -KILL $$'] });
    assert.deepEqual((await b.ended).end, { kind: 'exited', code: null, signal: 'SIGKILL' });
  });

  // PINS: output the program wrote just before exiting is ALL delivered before
  // `onExit` — what is still in the terminal when the program is reaped.
  //
  // DETERMINISTIC by a stopped reader: the helper ($PPID of the program) is
  // SIGSTOPped, the program writes DRAIN_BYTES into the terminal and exits —
  // which it can only do because DRAIN_BYTES fits the terminal's buffer — and
  // only once it is a zombie is the helper continued. It then finds the exit
  // with the whole output still unread, and one read of the terminal returns
  // far less than DRAIN_BYTES (measured: 4095), so only the post-exit drain
  // can deliver the rest. Measured: 8000 bytes fit and 12000 do not on Linux
  // 6.17; the precondition below fails by name where the buffer is smaller.
  row('output still in the terminal when the program exits is delivered before onExit', async (sys, cwd) => {
    const DRAIN_BYTES = 8000;
    const s = await openSession(sys, {
      cwd,
      argv: ['sh', '-c', `echo IDS=$$,$PPID; while [ ! -e GO ]; do sleep 0.01; done; `
        + `head -c ${DRAIN_BYTES} /dev/zero | tr '\\0' x; printf END`],
    });
    const [, pid, helper] = (await s.until(/IDS=(\d+),(\d+)\r\n/)).map(Number);
    const before = s.out.length;
    process.kill(helper, 'SIGSTOP');
    try {
      await fs.writeFile(path.join(cwd, 'GO'), '');
      assert.ok(await settle(async () => (await procState(pid)) === 'Z'),
        `precondition: the program exits while its reader is stopped — ${DRAIN_BYTES} bytes must fit the terminal's buffer`);
    } finally {
      process.kill(helper, 'SIGCONT');
    }
    const { end, outAtExit } = await s.ended;
    assert.deepEqual(end, { kind: 'exited', code: 0, signal: null });
    assert.equal(outAtExit.length - before, DRAIN_BYTES + 3, 'every byte arrived before onExit');
    assert.ok(outAtExit.endsWith('END'), 'the last bytes too');
  });

  // PINS: the terminal opens at the size asked for, and `resize` changes what
  // the program sees.
  row('the terminal has the size asked for, and resize changes it', async (sys, cwd) => {
    const s = await openSession(sys, { cwd, cols: 80, rows: 24, argv: ['sh', '-c', 'stty size; read x; stty size; read y'] });
    await s.until(/^24 80\r$/m);
    s.terminal.resize(100, 40);
    s.terminal.write('\n');
    await s.until(/^40 100\r$/m);
    s.terminal.close();
  });

  // PINS: ^C is in-band — byte 0x03 becomes SIGINT to the foreground job.
  row('^C interrupts the foreground job', async (sys, cwd) => {
    const s = await openSession(sys, {
      cwd, argv: ['sh', '-c', 'trap "echo GOT_INT; exit 3" INT; echo READY; while :; do sleep 0.05; done'],
    });
    await s.until(/READY/);
    s.terminal.write('\x03');
    await s.until(/GOT_INT/);
    assert.deepEqual((await s.ended).end, { kind: 'exited', code: 3, signal: null });
  });

  // PINS: `close()` ends the terminal as `closed` and kills its session — the
  // program AND the job it backgrounded.
  row('close kills the program and its background job', async (sys, cwd) => {
    const s = await openSession(sys, { cwd, argv: ['sh', '-c', 'sleep 1000 & echo BG=$!; echo PID=$$; wait'] });
    const [, bg] = await s.until(/BG=(\d+)/);
    const [, pid] = await s.until(/PID=(\d+)/);
    assert.ok(alive(Number(bg)) && alive(Number(pid)), 'both are running before the close');
    s.terminal.close();
    s.terminal.close();
    assert.deepEqual((await s.ended).end, { kind: 'closed' });
    assert.ok(await settle(() => !alive(Number(pid)) && !alive(Number(bg))),
      `the program (${pid}) and its background job (${bg}) are gone`);
  });

  // PINS: aborting the spec's signal is `close()`, and a signal already aborted
  // refuses the open ECANCELLED.
  row('aborting the signal closes the terminal', async (sys, cwd) => {
    const ac = new AbortController();
    const s = await openSession(sys, { cwd, signal: ac.signal, argv: ['sh', '-c', 'echo PID=$$; exec sleep 1000'] });
    const [, pid] = await s.until(/PID=(\d+)/);
    ac.abort();
    assert.deepEqual((await s.ended).end, { kind: 'closed' });
    assert.ok(await settle(() => !alive(Number(pid))), `the program (${pid}) is gone`);
    const gone = new AbortController();
    gone.abort();
    await assert.rejects(openSession(sys, { cwd, signal: gone.signal, argv: ['true'] }),
      (e) => e.name === 'SystemError' && e.code === 'ECANCELLED');
  });

  // PINS: nothing reaches `onData` between `pause()` and `resume()`, and
  // nothing is lost by it. The program's `touch` runs after its `echo`, so once
  // the file exists the output has been written.
  row('pause holds output back and resume delivers it', async (sys, cwd) => {
    const s = await openSession(sys, { cwd, argv: ['sh', '-c', 'read x; echo GOT_$x; touch DONE; read y'] });
    s.terminal.pause();
    const before = s.calls;
    s.terminal.write('go\n');
    assert.ok(await settle(() => fs.access(path.join(cwd, 'DONE')).then(() => true, () => false)),
      'the program wrote its output');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(s.calls, before, 'nothing was delivered while paused');
    s.terminal.resume();
    await s.until(/GOT_go/);
    s.terminal.close();
  });

  // PINS: the per-system cap refuses one terminal too many with 429
  // TERMINAL_LIMIT, a close frees its slot, and so does an open that failed.
  row('the per-system cap refuses one too many, and frees a slot on close or failure', async (sys, cwd) => {
    const a = await openSession(sys, { cwd, argv: ['cat'] });
    const b = await openSession(sys, { cwd, argv: ['cat'] });
    await assert.rejects(openSession(sys, { cwd, argv: ['cat'] }),
      (e) => e.statusCode === 429 && e.code === 'TERMINAL_LIMIT');
    a.terminal.close();
    const c = await openSession(sys, { cwd, argv: ['cat'] });
    b.terminal.close();
    c.terminal.close();
    for (let i = 0; i < 3; i++) {
      await assert.rejects(openSession(sys, { cwd, argv: [path.join(cwd, 'no-such-program')] }),
        (e) => e.code === 'ENOENT', `attempt ${i}: a failed open holds no slot`);
    }
  }, { maxTerminals: 2 });

  // PINS: a spec cc built wrong throws before anything is opened — it is cc's
  // own bug, never a target's answer.
  row('an invalid spec throws', async (sys, cwd) => {
    const bad = [
      { cwd: 'relative', argv: ['true'] },
      { cwd, cols: 0, argv: ['true'] },
      { cwd, rows: 1.5, argv: ['true'] },
      { cwd, term: 'x term', argv: ['true'] },
      { cwd, argv: [] },
      { cwd, argv: ['tr\0ue'] },
      { cwd, env: { 'BAD-NAME': 'x' }, argv: ['true'] },
    ];
    for (const spec of bad) {
      await assert.rejects(openSession(sys, spec), (e) => e.name === 'Error' && /openTerminal|envOverlay/.test(e.message),
        JSON.stringify(spec));
    }
    const s = await openSession(sys, { cwd, argv: ['cat'] });
    assert.throws(() => s.terminal.resize(0, 10), /resize: cols/);
    s.terminal.close();
  });

  // PINS (F4): the env overlay is in the PROGRAM's environment and absent from
  // the environment of the pty helper hosting it — the program's parent. The
  // probe set includes a loader variable, the kind that would reach the
  // interpreter running the helper.
  row('the env overlay reaches the program and never the helper', async (sys, cwd, t) => {
    if (!await fs.access('/proc/self/environ').then(() => true, () => false)) {
      t.skip('no /proc on this host: a process\'s environment cannot be read');
      return;
    }
    const s = await openSession(sys, {
      cwd, env: { CC_F4_PROBE: 'f4-on', LD_LIBRARY_PATH: '/cc-f4-probe' },
      argv: ['sh', '-c', 'echo "HOST=$PPID V=$CC_F4_PROBE L=$LD_LIBRARY_PATH"; read x'],
    });
    const [, host, v, l] = await s.until(/HOST=(\d+) V=(\S*) L=(\S*)\r\n/);
    assert.equal(v, 'f4-on', 'the overlay is in the program\'s environment');
    assert.equal(l, '/cc-f4-probe', 'the loader variable too');
    const cmdline = await fs.readFile(`/proc/${host}/cmdline`, 'latin1');
    assert.ok(cmdline.includes('ptyHelper.py'), `precondition: the program's parent is the pty helper (${cmdline})`);
    const environ = (await fs.readFile(`/proc/${host}/environ`, 'latin1')).split('\0');
    assert.equal(environ.some((e) => e.startsWith('CC_F4_PROBE=')), false, 'the overlay is not in the helper\'s environment');
    assert.equal(environ.includes('LD_LIBRARY_PATH=/cc-f4-probe'), false, 'nor is the loader variable');
    s.terminal.close();
    await s.ended;
  });

  // PINS: input far past one input-credit window reaches the program with no
  // byte lost, duplicated or reordered — credit keeps returning.
  row('input past one window arrives intact', async (sys, cwd) => {
    const W = protocol.PTY_INPUT_WINDOW_BYTES;
    assert.equal(typeof W, 'number', 'PTY_INPUT_WINDOW_BYTES is exported');
    const data = patternBytes(4 * W);
    const s = await openSession(sys, { cwd, argv: hashInput(data.length) });
    await s.until(/READY/);
    s.terminal.write(data);
    const [, digest] = await s.until(DIGEST_RE, 30_000);
    assert.equal(digest, sha256(data));
    assert.deepEqual((await s.ended).end, { kind: 'exited', code: 0, signal: null });
  });

  // PINS: `write` returns false once the input the program has not read reaches
  // the high-water mark, never drains while the program does not read, and
  // fires `onDrain` once it has read everything — and no byte written past the
  // `false` is dropped.
  row('write reports backpressure while the program does not read, and drains when it does', async (sys, cwd) => {
    const W = protocol.PTY_INPUT_WINDOW_BYTES;
    const HIGH = terminalModule.TERMINAL_WRITE_HIGH_WATER_BYTES;
    assert.equal(typeof W, 'number', 'PTY_INPUT_WINDOW_BYTES is exported');
    assert.equal(typeof HIGH, 'number', 'TERMINAL_WRITE_HIGH_WATER_BYTES is exported');
    const data = patternBytes(4 * W);
    const s = await openSession(sys, { cwd, argv: hashInput(data.length, 'GO') });
    await s.until(/READY/);
    const STEP = 16 * 1024;
    const results = [];
    for (let at = 0; at < data.length; at += STEP) results.push(s.terminal.write(data.subarray(at, at + STEP)));
    // The loop is synchronous, so no write can have been reported in it: the
    // first `false` is the write that took the unread total TO the mark.
    const first = Math.ceil(HIGH / STEP) - 1;
    assert.deepEqual(results.slice(0, first + 1), [...Array(first).fill(true), false],
      'write reports backpressure exactly when the unread input reaches the high-water mark');
    // Far more than the terminal can hold is unread, so nothing can drain.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.drains, 0, 'no onDrain while the program reads nothing');
    await fs.writeFile(path.join(cwd, 'GO'), '');
    await s.drained();
    const [, digest] = await s.until(DIGEST_RE, 30_000);
    assert.equal(digest, sha256(data), 'every byte, including those written after `false`, arrived');
    assert.deepEqual((await s.ended).end, { kind: 'exited', code: 0, signal: null });
    assert.equal(s.drains, 1, 'onDrain fired once');
  });
}
