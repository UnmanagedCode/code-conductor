// THE CONFORMANCE SUITE: this file is the definition of a valid provider.
//
// docs/systems-protocol.md is what a provider author reads; this is what their
// provider has to survive. It drives the reference provider through the three
// MUST primitives, the full `exec` frame lifecycle including process-group
// signalling, capability negotiation, multiplexed ids, every error code and
// every derivation — in EVERY entry of `CAPABILITY_CONFIGS` (the harness owns
// the list; the count is deliberately not restated here), so no fallback is a
// flag nobody has run.
//
// WHAT IT PROVES FOR A THIRD-PARTY PROVIDER IS NARROWER, and card 2026-0313
// measured how much: see docs/systems-protocol.md §10.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHUNK_BYTES, FS_ERROR_CODES, MAX_FILE_BYTES, PROTOCOL_ERROR_CODES, PROTOCOL_VERSION,
} from '../src/systems/protocol.ts';
import { ProviderConnection } from '../src/systems/providerConnection.ts';
import { parseFindLines } from '../src/systems/providerSystem.ts';
import {
  CAPABILITY_CONFIGS, IS_REFERENCE_PROVIDER, REMOTE_ID_ENV, TOGGLED_CAPABILITIES,
  assertNegotiatedCapabilities, conformanceRemoteId, makeProviderSystem, providerArgv,
} from './referenceProviderHarness.mjs';

// The binding for a frame or a flag a fixture builds by hand. Empty — so the
// default run is byte-identical — unless CC_CONFORMANCE_REMOTE_ID is set.
const BOUND = conformanceRemoteId() === null ? {} : { remoteId: conformanceRemoteId() };
const FLAG_TARGET = conformanceRemoteId() === null ? '' : `${conformanceRemoteId()}=`;
import { rmrf } from './rmrf.mjs';
import { msFromNanos } from '../src/systems/system.ts';

// Every taxonomy code this file provokes for real. The last test checks the
// union against the exported lists, so a new code cannot be added to the
// protocol without something producing it.
const produced = new Set();
function expectCode(e, code, what) {
  assert.equal(e.code, code, `${what}: expected ${code}, got ${e.code} (${e.message})`);
  produced.add(code);
  return true;
}

// The ABSENT-BEHAVIOUR rows below assert what CC does when a provider advertises
// a capability it does not have — they use a provider as a FIXTURE rather than
// testing one, so they are pinned to the reference provider and skip for any
// third-party one WHATEVER ITS SHAPE. The gate is provider identity, not
// capability: a third-party provider that can advertise `remotes:false` still
// skips them, so the reason must not claim it cannot. (The shape that motivates
// the pin: a kind that always serves named targets cannot supply that fixture
// at all, and must not be made to lie to try.)
const CC_SIDE_ONLY = IS_REFERENCE_PROVIDER
  ? false
  : 'cc-side fixture, pinned to the reference provider: asserts what CC does, not what a provider does';

async function withSystem(flags, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-conformance-'));
  const root = await fs.realpath(dir);
  const sys = makeProviderSystem(flags);
  try {
    await sys.connect();
    return await fn(sys, root);
  } finally {
    sys.dispose();
    await rmrf(dir);
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function settle(pred, ms = 3_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return pred();
}

for (const config of CAPABILITY_CONFIGS) {
  const tag = `[${config.name}]`;

  // ── Handshake and capability negotiation ─────────────────────────

  // The descriptor assertions went with card 2026-0312: the hello carries no
  // `system` object at all, and this suite's provider sends none — so every
  // operation below is also the positive half of "a hello with no descriptor
  // yields a System that works" (T8's other half is in
  // tests/systems-provider-supervision.test.mjs).
  test(`${tag} the handshake carries the protocol version, the provider name and the capabilities`, async () => {
    await withSystem(config.flags, async (sys) => {
      const hs = sys.handshake;
      assertNegotiatedCapabilities(hs.capabilities, config);
      assert.match(hs.provider, /^\S+\/\S+$/, 'a provider names and versions itself');
      if (IS_REFERENCE_PROVIDER) assert.match(hs.provider, /^reference-local\//);
      assert.equal('system' in hs, false, 'cc records no descriptor, because it reads none');
      assert.equal(PROTOCOL_VERSION, 1);
    });
  });

  // ── exec: the primitive ──────────────────────────────────────────

  test(`${tag} exec runs argv and shell forms, and reports stdout, stderr and the exit code`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const a = await sys.exec({ argv: ['echo', 'hello'] }, { cwd: root });
      assert.deepEqual(
        { code: a.code, stdout: a.stdout, stderr: a.stderr, timedOut: a.timedOut, spawnError: a.spawnError },
        { code: 0, stdout: 'hello\n', stderr: '', timedOut: false, spawnError: null },
      );
      const b = await sys.exec({ shell: 'echo out; echo err >&2; exit 5' }, { cwd: root });
      assert.equal(b.code, 5);
      assert.equal(b.stdout, 'out\n');
      assert.equal(b.stderr, 'err\n');
      assert.equal(b.output.includes('out'), true, 'output carries both streams in arrival order');
      assert.equal(b.output.includes('err'), true);
      const c = await sys.exec({ argv: ['pwd'] }, { cwd: root });
      assert.equal(c.stdout.trim(), root, 'cwd on the frame is where the command runs');
      const d = await sys.exec({ argv: ['sh', '-c', 'echo "$CC_PROBE"'] }, { cwd: root, env: { CC_PROBE: 'from-frame', PATH: process.env.PATH } });
      assert.equal(d.stdout.trim(), 'from-frame', 'env on the frame REPLACES the environment, as spawn does');
    });
  });

  test(`${tag} exec NEVER rejects — a command that cannot start is a spawnError, not a throw`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const r = await sys.exec({ argv: ['definitely-not-a-real-binary-xyz'] }, { cwd: root });
      assert.equal(r.code, 1);
      assert.ok(r.spawnError, 'the caller distinguishes "failed to launch" from "ran and exited 1"');
      assert.equal(r.stderr, r.spawnError, 'the message fills the fields callers read diagnostics from');
      assert.equal(r.output, r.spawnError);
      assert.equal(r.timedOut, false);
    });
  });

  // PINS: the CODE on a provider's id-addressed `error` frame reaches the
  // caller as `spawnErrorCode`, rather than being thrown away and re-derived
  // from the message prose.
  test(`${tag} a command that cannot start carries the provider's own error code`, async () => {
    await withSystem(config.flags, async (sys) => {
      const r = await sys.exec({ argv: ['true'] }, { cwd: '/definitely-not-a-real-directory-xyz' });
      assert.equal(r.code, 1);
      assert.ok(r.spawnError);
      assert.equal(r.spawnErrorCode, 'ENOENT', 'the structured code the far side sent, not a parse of its message');
      assert.equal(r.transportFailure, undefined, 'the far side ANSWERED — this is not a dead channel');
    });
  });

  test(`${tag} a timeout is exit 124 with timedOut set`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const r = await sys.exec({ argv: ['sleep', '10'] }, { cwd: root, timeoutMs: 250 });
      assert.equal(r.timedOut, true);
      assert.equal(r.code, 124, "124 is timeout(1)'s convention, which cc's callers already branch on");
      assert.ok(r.durationMs < 9_000, 'the command really was killed, not waited out');
    });
  });

  test(`${tag} process-group signalling: the capability decides whether grandchildren are reachable`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const pidFile = path.join(root, 'grandchild.pid');
      // bash is the direct child; `sleep` is the grandchild that outlives it
      // unless the whole GROUP is signalled — the orphaned-`npm ci` failure.
      // The grandchild's own stdout goes to /dev/null so it does not hold the
      // command's pipes open after the direct child dies; what is under test is
      // the SIGNAL's reach, not how long an orphan keeps a pipe.
      const r = await sys.exec(
        { shell: `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; wait` },
        { cwd: root, timeoutMs: 300 },
      );
      assert.equal(r.timedOut, true);
      assert.ok(r.durationMs < 3_000,
        'the exit frame came from the provider, not from cc\'s wedge backstop');
      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      assert.ok(pid > 0, 'the grandchild recorded its pid');
      try {
        if (config.caps.processGroupSignal) {
          assert.equal(r.descendantsMaySurvive, undefined,
            'with group reach the result claims nothing was left behind');
          assert.equal(await settle(() => !alive(pid)), true,
            'and the grandchild really is gone — one kill reached the whole group');
        } else {
          // Asserted on the FLAG, not on a race against real process death.
          assert.equal(r.descendantsMaySurvive, true,
            'without group reach the result SAYS grandchildren may survive');
        }
      } finally {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    });
  });

  // ── detach: end the operation without ending the command ─────────
  //
  // MEASURED (card 2026-0318 §1, §3): a `cmd &` job inherits the command's
  // stdout pipe, so the provider's `'close'` — and with it the `exit` frame —
  // does not fire when the command exits. cc therefore settles a redirected
  // command on its OWN framing sentinel, and then has to tell the provider that
  // the operation is over WITHOUT telling it to kill anything. `close` cannot
  // say that: it is normatively "abandon and kill hard".
  //
  // PINS BOTH HALVES OF `detach`, against `close` as the contrast on the same
  // fixture and in the same configuration:
  //   * STOP REPORTING — not one more frame on that id, `exit` included;
  //   * KILL NOTHING — the survivor is alive in BOTH capability configurations,
  //     including the one where `close` reaps it through the process group.
  test(`${tag} detach ends the operation and kills nothing; close kills as far as it reaches`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-detach-'));
    const root = await fs.realpath(dir);
    const conn = new ProviderConnection({ launch: { argv: providerArgv(config.flags) } });
    const started = [];
    // A job that keeps PRINTING, so "reporting stopped" is observed rather than
    // inferred: a silent survivor would make the assertion vacuous.
    const ticker = (pidFile) =>
      `{ while :; do echo tick; sleep 0.05; done; } & echo $! > ${pidFile}; echo started`;
    // The exec's OWN deadline, short: a provider that ignored the frame under
    // test still has its timer armed, and this is what makes that visible
    // inside the test rather than 605 s later.
    const EXEC_MS = 700;
    const launch = async (name) => {
      const pidFile = path.join(root, `${name}.pid`);
      const id = conn.nextId('e');
      const frames = [];
      conn.open(id, { frame: (f) => frames.push(f), down: () => {} });
      conn.send({ type: 'exec', id, ...BOUND, cwd: root, shell: ticker(pidFile), timeoutMs: EXEC_MS });
      assert.equal(await settle(() => frames.filter(f => f.type === 'stdout').length >= 2), true,
        `${name}: the provider never reported the job's output — nothing is under test`);
      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      assert.ok(pid > 0, `${name}: the job recorded its pid`);
      started.push(pid);
      return { id, frames, pid };
    };
    try {
      await conn.ensureUp();
      const d = await launch('detached');
      const c = await launch('closed');

      conn.send({ type: 'detach', id: d.id });
      conn.send({ type: 'close', id: c.id });
      const at = { detached: d.frames.length, closed: c.frames.length };
      // Long enough to be past the exec deadline both were given, so a provider
      // that ignored `detach` has fired its own timer by now.
      await new Promise((r) => setTimeout(r, EXEC_MS + 400));

      assert.equal(d.frames.length, at.detached,
        `detach: ${d.frames.length - at.detached} more frames arrived on a detached id `
        + `(${[...new Set(d.frames.slice(at.detached).map(f => f.type))].join(', ')}) — `
        + 'detach means stop reporting, exit included');
      assert.equal(c.frames.length, at.closed, 'close goes quiet on the id too');

      assert.equal(alive(d.pid), true,
        'detach kills NOTHING — the job outlives the operation in both capability configurations');
      // The contrast, and it is capability-keyed because `close`'s reach is:
      // with a process group one kill reaches the survivor, without one it
      // cannot (the same split tests/systems-protocol-conformance.test.mjs
      // already pins for `signal`).
      if (config.caps.processGroupSignal) {
        assert.equal(await settle(() => !alive(c.pid)), true,
          'close still kills hard, and with group reach that includes the survivor');
      } else {
        assert.equal(alive(c.pid), true, 'without group reach close cannot get to it either');
      }
    } finally {
      conn.dispose();
      for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      await rmrf(dir);
    }
  });

  // THE PARITY PIN (card 2026-0318 §3). The two shipped configurations used to
  // DISAGREE about whether a redirected background job survives its command:
  // cc's abandon timer sent `close`, which reaps the survivor through the
  // process group where it has one and cannot reach it where it does not. A
  // sentinel-settle closes that divergence — the job survives in BOTH, which is
  // what a LOCAL Bash call does (card 2026-0318 §1/Q3).
  //
  // NOTE ON ITS RED: the settle is what this asserts on, so before the fix the
  // run throws ETIMEDOUT and the aliveness assertion is never reached. That is
  // inherent — there is no sentinel-settle to survive until there is one.
  test(`${tag} a redirected background job outlives its command, in both capability configurations`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const pidFile = path.join(root, 'bg.pid');
      let pid = 0;
      try {
        const r = await sys.shell({ cwd: root, commandTimeoutMs: 500 })
          .run(`sleep 30 & echo $! > ${pidFile}; echo started`);
        assert.equal(r.code, 0, 'the command exited 0 and is reported as exit 0');
        assert.equal(r.stdout, 'started\n');
        pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
        assert.ok(pid > 0, 'the job recorded its pid');
        // PAST the deadline the provider was given for that command: nothing
        // reaches back to kill the job when that timer would have fired.
        await new Promise((res) => setTimeout(res, 800));
        assert.equal(alive(pid), true, 'the job outlives the command, as it does locally');
      } finally {
        if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
    });
  });

  test(`${tag} concurrent execs are multiplexed by id and never mix their output`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const started = Date.now();
      const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      const rs = await Promise.all(tags.map(t =>
        sys.exec({ shell: `sleep 0.25; echo ${t}; echo ${t}-err >&2` }, { cwd: root })));
      rs.forEach((r, i) => {
        assert.equal(r.stdout, `${tags[i]}\n`, 'each id got exactly its own stdout');
        assert.equal(r.stderr, `${tags[i]}-err\n`);
        assert.equal(r.code, 0);
      });
      assert.ok(Date.now() - started < 1_000,
        'five 250ms commands finished together — the ids really are open concurrently');
    });
  });

  test(`${tag} the exec output caps behave identically to the local runner`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const spew = { shell: 'for i in $(seq 1 500); do echo 0123456789012345678901234567890123456789; done' };
      const tail = await sys.exec(spew, { cwd: root, cap: 200 });
      assert.equal(tail.truncated, true);
      assert.equal(tail.stdout.length, 200, 'a tail cap keeps the LAST bytes');
      assert.ok(tail.stdout.endsWith('0123456789\n'));
      const head = await sys.exec(spew, { cwd: root, headCapBytes: 200 });
      assert.equal(head.truncated, true);
      assert.ok(head.stdout.length >= 200, 'a head cap keeps the FIRST bytes and keeps draining');
      assert.equal(head.code, 0, 'the command still ran to completion under a head cap');
      const fenced = await sys.exec(spew, { cwd: root, maxBufferBytes: 500 });
      assert.equal(fenced.code, 1, 'the max-buffer fence is a FAILURE, not a truncated success');
      assert.match(fenced.stderr, /exceeded the 500-byte limit/);
      assert.ok(fenced.stdout.length > 0, 'the output that arrived first is kept');
      assert.ok(fenced.stdout.length < 5_000, 'and retention stops at the fence');
    });
  });

  test(`${tag} stdin:'ignore' hands the command a closed stdin instead of a wait`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const r = await sys.exec({ argv: ['cat'] }, { cwd: root, stdin: 'ignore', timeoutMs: 2_000 });
      assert.equal(r.timedOut, false, 'an interactive command sees EOF rather than hanging to the timeout');
      assert.equal(r.code, 0);
    });
  });

  // ── readFile / writeFile: the other two primitives ────────────────

  test(`${tag} readFile and writeFile round-trip, including a payload past one chunk`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const p = path.join(root, 'note.txt');
      await sys.writeFile(p, 'hello — héllo\n');
      assert.equal(await fs.readFile(p, 'utf8'), 'hello — héllo\n');
      assert.equal(await sys.readFile(p), 'hello — héllo\n');

      const big = path.join(root, 'big.bin');
      const payload = 'x'.repeat(CHUNK_BYTES * 3 + 17);
      await sys.writeFile(big, payload);
      assert.equal((await sys.readFile(big)).length, payload.length, 'chunking is transparent in both directions');
      const head = await sys.readFileBytes(big, { length: 10 });
      assert.equal(head.toString('utf8'), 'x'.repeat(10), 'the ranged read is bounded');
      assert.equal((await sys.readFileBytes(big)).length, payload.length, 'and unbounded without a length');
    });
  });

  test(`${tag} writeFile honours atomic and exclusive, and refuses the pair`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const p = path.join(root, 'x.txt');
      await sys.writeFile(p, 'first', { exclusive: true });
      await assert.rejects(() => sys.writeFile(p, 'second', { exclusive: true }),
        (e) => expectCode(e, 'EEXIST', 'exclusive write over an existing file'));
      assert.equal(await fs.readFile(p, 'utf8'), 'first', 'the refusal left the file alone');
      await sys.writeFile(p, 'third', { atomic: true });
      assert.equal(await fs.readFile(p, 'utf8'), 'third', 'an atomic write overwrites — it ends in a rename');
      await assert.rejects(() => sys.writeFile(p, 'x', { atomic: true, exclusive: true }),
        /mutually exclusive/, 'the combination has no honest meaning, on either implementation');
    });
  });

  test(`${tag} readFile reports absence, a directory, and an unreadable file`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      await assert.rejects(() => sys.readFile(path.join(root, 'nope')),
        (e) => expectCode(e, 'ENOENT', 'readFile of a missing path'));
      await assert.rejects(() => sys.readFile(root),
        (e) => expectCode(e, 'EISDIR', 'readFile of a directory'));
      if (process.getuid?.() !== 0) {
        const locked = path.join(root, 'locked');
        await fs.writeFile(locked, 'secret');
        await fs.chmod(locked, 0o000);
        try {
          await assert.rejects(() => sys.readFile(locked),
            (e) => expectCode(e, 'EACCES', 'readFile of an unreadable file'));
        } finally { await fs.chmod(locked, 0o600); }
      }
    });
  });

  test(`${tag} a read above the protocol's per-file cap is refused, not streamed`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const p = path.join(root, 'small');
      await fs.writeFile(p, 'small');
      await assert.rejects(() => sys.readFileBytes(p, { length: MAX_FILE_BYTES + 1 }),
        (e) => expectCode(e, 'EFBIG', 'a read past the per-file cap'));
    });
  });

  // ── The derivations (everything that is not a primitive) ─────────

  test(`${tag} stat is derived from exec and matches what fs.stat reports`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const f = path.join(root, 'f');
      await fs.writeFile(f, 'abcdef');
      const real = await fs.stat(f);
      const got = await sys.stat(f);
      assert.equal(got.kind, 'file');
      assert.equal(got.size, 6);
      assert.equal(got.mode, real.mode, 'the RAW mode, type bits and all — the same number fs.Stats carries');
      assert.ok(Math.abs(got.mtimeMs - real.mtimeMs) < 1.5, 'mtime keeps millisecond precision');
      assert.equal((await sys.stat(root)).kind, 'dir');
      assert.equal(await sys.stat(path.join(root, 'nope')), null,
        'ABSENCE IS A VALUE: a missing path is null, matching resolveProjectDir');
      await fs.symlink(f, path.join(root, 'link'));
      assert.equal((await sys.stat(path.join(root, 'link'))).kind, 'file', 'stat follows symlinks, like fs.stat');
      await fs.symlink(path.join(root, 'gone'), path.join(root, 'broken'));
      assert.equal(await sys.stat(path.join(root, 'broken')), null, 'a broken link is absent, not an error');
    });
  });

  test(`${tag} readDir is derived from exec, reports kinds, and refuses a file`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const dir = path.join(root, 'd');
      await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a file with spaces'), 'x');
      await fs.symlink(path.join(dir, 'sub'), path.join(dir, 'lnk'));
      const entries = (await sys.readDir(dir)).sort((x, y) => x.name.localeCompare(y.name));
      assert.deepEqual(entries.map(({ name, kind, target }) => ({ name, kind, target })), [
        { name: 'a file with spaces', kind: 'file', target: null },
        { name: 'lnk', kind: 'symlink', target: path.join(dir, 'sub') },
        { name: 'sub', kind: 'dir', target: null },
      ], 'a symlink is reported as one WITH ITS TARGET, matching fs.readdir(withFileTypes) plus fs.readlink');
      // ONE ROUND TRIP CARRIES THE WHOLE ENTRY. A listing that reported name
      // and kind alone would cost 1 + N round trips to answer the same
      // question, which across a wire is N latencies.
      // The oracle derives ms the way the implementation does — from integer
      // nanoseconds through `msFromNanos` — not by re-rounding
      // `fs.Stats.mtimeMs`, which is the formula that fix removed and which
      // disagrees with it on a half-millisecond boundary.
      const real = await fs.lstat(path.join(dir, 'a file with spaces'), { bigint: true });
      assert.deepEqual(entries[0], {
        name: 'a file with spaces', kind: 'file', target: null,
        size: Number(real.size), mode: (Number(real.mode) & 0o7777) | 0o100000,
        mtimeMs: msFromNanos(Number(real.mtimeNs / 1000000000n), Number(real.mtimeNs % 1000000000n)),
      });
      assert.equal(entries[2].mode & 0o170000, 0o040000, 'a directory carries its type bits too');
      await assert.rejects(() => sys.readDir(path.join(dir, 'a file with spaces')),
        (e) => expectCode(e, 'ENOTDIR', 'readDir of a file'),
        'a file must not read as an empty directory');
      await assert.rejects(() => sys.readDir(path.join(root, 'nope')),
        (e) => expectCode(e, 'ENOENT', 'readDir of a missing path'));
    });
  });

  test(`${tag} a filename containing a newline OR A TAB is an ERROR, never a silently dropped entry`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      // TWO DIRECTIONS, because the widened `-printf` is parsed by FIELD COUNT:
      // a newline gives too few fields and a tab gives too many, and a guard
      // that checked only one bound would let the other through as a
      // MISATTRIBUTED entry — a name read as a mode, silently.
      // THREE SHAPES, because the field count alone has a hole. A name whose
      // LAST character is a newline emits a well-formed six-field record plus
      // an EMPTY line, so the count check passes and the entry came back named
      // `trailing` — COLLIDING with the real sibling of that name below. A
      // silent mis-naming, not a dropped entry, in the exact class the rule
      // exists for.
      for (const bad of ['two\nlines', 'two\ttabs', 'trailing\n']) {
        const dir = path.join(root, `weird-${Buffer.from(bad).toString('hex')}`);
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, 'plain'), 'x');
        // The sibling a trailing newline would be mistaken FOR. Its presence is
        // what makes the mis-naming a collision rather than a curiosity.
        await fs.writeFile(path.join(dir, bad.replace(/[\n\t]/g, '')), 'x');
        await fs.writeFile(path.join(dir, bad), 'x');
        await assert.rejects(() => sys.readDir(dir),
          (e) => expectCode(e, 'EUNKNOWN', `a listing cc cannot parse (${JSON.stringify(bad)})`),
          'a listing that quietly drops an entry is indistinguishable from one that does not have it');
      }
    });
  });

  // ── lstat, readlink, symlink, removeEntry: the union transport's four ────
  test(`${tag} lstat reports a SYMLINK as one, with its target, where stat cannot`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const f = path.join(root, 'f');
      await fs.writeFile(f, 'abcdef');
      await fs.chmod(f, 0o640);
      await fs.symlink('relative/target', path.join(root, 'link'));
      await fs.symlink(path.join(root, 'gone'), path.join(root, 'broken'));

      const real = await fs.lstat(f, { bigint: true });
      assert.deepEqual(await sys.lstat(f), {
        kind: 'file', size: 6, mode: 0o100640, target: null,
        mtimeMs: msFromNanos(Number(real.mtimeNs / 1000000000n), Number(real.mtimeNs % 1000000000n)),
      }, 'a FULL mode — permission bits from %m, type bits from the kind');

      const link = await sys.lstat(path.join(root, 'link'));
      assert.equal(link.kind, 'symlink', 'stat follows and would say "file"; lstat must not');
      assert.equal(link.target, 'relative/target');
      assert.equal(link.mode & 0o170000, 0o120000);
      // A BROKEN LINK IS PRESENT, and that is the whole difference from `stat`,
      // whose `-L` reports it absent.
      assert.equal((await sys.lstat(path.join(root, 'broken'))).kind, 'symlink');
      assert.equal(await sys.stat(path.join(root, 'broken')), null);

      assert.equal((await sys.lstat(root)).kind, 'dir');
      assert.equal(await sys.lstat(path.join(root, 'nope')), null, 'ABSENCE IS A VALUE');
      assert.equal(await sys.lstat(path.join(f, 'x')), null,
        'and a non-directory component is absence too — there is no entry there');
    });
  });

  test(`${tag} readlink, symlink and removeEntry are derived and behave like fs`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const p = (rel) => path.join(root, rel);
      await sys.symlink('first', p('sl'));
      assert.equal(await sys.readlink(p('sl')), 'first');
      // -f: REPLACES. Without it the second call is EEXIST and every re-link
      // in the union's reconcile fails.
      await sys.symlink('second', p('sl'));
      assert.equal(await sys.readlink(p('sl')), 'second');
      await fs.writeFile(p('plain'), 'x');
      await sys.symlink('third', p('plain'));
      assert.equal(await sys.readlink(p('plain')), 'third');
      await fs.writeFile(p('notalink'), 'x');
      await assert.rejects(() => sys.readlink(p('nope')),
        (e) => expectCode(e, 'ENOENT', 'readlink of a missing path'));
      // NOT A SYMLINK is a different answer from NOT THERE, and a caller that
      // cannot tell them apart cannot tell either from the box hiccuping.
      await assert.rejects(() => sys.readlink(p('notalink')),
        (e) => expectCode(e, 'EINVAL', 'readlink of a path that is not a symlink'));

      // removeEntry: ONE entry, never recursing, never following.
      await fs.writeFile(p('victim'), 'x');
      await sys.removeEntry(p('victim'));
      assert.equal(await sys.lstat(p('victim')), null);
      await fs.mkdir(p('target'));
      await sys.symlink(p('target'), p('alias'));
      await sys.removeEntry(p('alias'));
      assert.equal(await sys.lstat(p('alias')), null);
      assert.equal((await sys.lstat(p('target'))).kind, 'dir', 'the link went, the target stayed');
      await sys.removeEntry(p('target'));
      assert.equal(await sys.lstat(p('target')), null, 'an EMPTY directory goes');

      await fs.mkdir(p('full'));
      await fs.writeFile(p('full/kid'), 'x');
      await assert.rejects(() => sys.removeEntry(p('full')),
        (e) => expectCode(e, 'ENOTEMPTY', 'removeEntry of a non-empty directory'));
      // ASSERTED AFTER THE REFUSAL: an `rm -rf` in disguise refuses nothing.
      assert.deepEqual((await sys.readDir(p('full'))).map(e => e.name), ['kid']);

      // AN ABSENT ENTRY IS THE DECLARED INTENT ALREADY MET — "hold nothing at
      // p" — so this RESOLVES rather than raising ENOENT.
      await sys.removeEntry(p('never-existed'));
    });
  });

  test(`${tag} writeFileBytes carries a byte a UTF-8 round trip does not survive`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const p = path.join(root, 'bin');
      const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x00, 0x80, 0xc3]);
      await sys.writeFileBytes(p, bytes, { atomic: true, mode: 0o750 });
      assert.deepEqual(await fs.readFile(p), bytes,
        'the wire already carries base64 of raw bytes; only cc converting on the way in ever mangled them');
      assert.deepEqual(await sys.readFileBytes(p), bytes);
      assert.equal((await fs.stat(p)).mode & 0o7777, 0o750,
        'and the mode rides the atomic write, so the rename does not reset it');
      // The control that makes the claim above non-vacuous: the same bytes
      // through the STRING write come back mangled, which is why the byte
      // entry point exists at all.
      await sys.writeFile(path.join(root, 'txt'), bytes.toString('utf8'));
      assert.notDeepEqual(await fs.readFile(path.join(root, 'txt')), bytes);
    });
  });

  test(`${tag} realpath, mkdir, removeTree, unlink and chmod are derived and behave like fs`, async () => {
    await withSystem(config.flags, async (sys, root) => {
      const target = path.join(root, 'real');
      await fs.mkdir(target);
      await fs.symlink(target, path.join(root, 'alias'));
      assert.equal(await sys.realpath(path.join(root, 'alias')), target);
      await assert.rejects(() => sys.realpath(path.join(root, 'nope')),
        (e) => expectCode(e, 'ENOENT', 'realpath of a missing path'),
        'realpath -e requires every component to exist, exactly as fs.realpath does');

      await sys.mkdir(path.join(root, 'one'));
      assert.equal((await sys.stat(path.join(root, 'one'))).kind, 'dir');
      await assert.rejects(() => sys.mkdir(path.join(root, 'one')),
        (e) => expectCode(e, 'EEXIST', 'a non-recursive mkdir over an existing dir'));
      await sys.mkdir(path.join(root, 'a/b/c'), { recursive: true });
      assert.equal((await sys.stat(path.join(root, 'a/b/c'))).kind, 'dir');
      await assert.rejects(() => sys.mkdir(path.join(root, 'x/y/z')),
        (e) => expectCode(e, 'ENOENT', 'a non-recursive mkdir with no parent'));

      const file = path.join(root, 'chmodme');
      await fs.writeFile(file, 'x');
      await fs.chmod(file, 0o644);
      // The mode a caller has in hand comes from stat and carries the file-type
      // bits; chmod must mask them rather than reject.
      const st = await sys.stat(file);
      await sys.chmod(file, st.mode | 0o111);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o755);

      await sys.unlink(file);
      assert.equal(await sys.stat(file), null);
      await assert.rejects(() => sys.unlink(file), (e) => expectCode(e, 'ENOENT', 'unlink of a missing entry'));
      // unlink removes ONE entry and never follows it — the shape the
      // `.external/<name>` record is deleted with.
      await sys.unlink(path.join(root, 'alias'));
      assert.equal((await sys.stat(target)).kind, 'dir', 'the symlink went, the target stayed');

      await sys.removeTree(path.join(root, 'a'));
      assert.equal(await sys.stat(path.join(root, 'a')), null);
      await sys.removeTree(path.join(root, 'never-existed'));
    });
  });
}

// ── Cases that do not vary by capability ─────────────────────────────

test('a provider refuses a corrupted write payload — it never lands a partial file', async () => {
  // The other direction of the same rule. `Buffer.from(s,'base64')` would keep
  // the readable prefix, so a doc-conforming provider that decoded leniently
  // would answer `writeFileResult ok` having written a TRUNCATED file: a
  // success report for a wrong answer, which is the one outcome the taxonomy
  // exists to prevent.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-badb64-'));
  const target = path.join(await fs.realpath(dir), 'must-not-exist');
  const conn = new ProviderConnection({ launch: { argv: providerArgv() } });
  try {
    await conn.ensureUp();
    const id = conn.nextId('w');
    const refusal = await new Promise((resolve) => {
      conn.open(id, { frame: (f) => { if (f.type === 'error' || f.type === 'writeFileResult') resolve(f); }, down: resolve });
      conn.send({ type: 'writeFile', id, ...BOUND, path: target });
      conn.send({ type: 'data', id, seq: 0, dataB64: Buffer.from('HELLO').toString('base64') });
      // Valid JSON, valid line, unusable payload.
      conn.send({ type: 'data', id, seq: 1, dataB64: 'V09STEQ=!!corrupted' });
      conn.send({ type: 'end', id });
    });
    assert.notEqual(refusal.type, 'writeFileResult', 'a corrupted payload must not report success');
    expectCode(refusal, 'EPROTO', 'a writeFile payload that is not valid base64');
    assert.equal(await fs.stat(target).then(() => 'exists', () => 'absent'), 'absent',
      'and no partial file was left behind');
  } finally {
    conn.dispose();
    await rmrf(dir);
  }
});

// ── remotes: one endpoint, many targets ──────────────────────────────
//
// Outside the per-configuration loop: `remotes` is orthogonal to the other two
// capabilities, and these launch their own provider with `--remote` flags.

// A provider serving `a` and `b`, each given its own root.
//
// The OWNER handle is explicitly unbound — `{ remoteId: null }` beats
// CC_CONFORMANCE_REMOTE_ID — because this block is ABOUT binding: every test
// here binds the target it wants, and one of them asserts what an UNBOUND
// request gets on a provider that has no default.
async function withRemotes(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-remotes-'));
  const root = await fs.realpath(dir);
  const rootA = path.join(root, 'a');
  const rootB = path.join(root, 'b');
  await fs.mkdir(rootA);
  await fs.mkdir(rootB);
  const sys = makeProviderSystem(['--remote', `a=${rootA}`, '--remote', `b=${rootB}`], { remoteId: null });
  try {
    await sys.connect();
    return await fn(sys, { rootA, rootB });
  } finally {
    sys.dispose();
    await rmrf(dir);
  }
}

test('a bound handle names its remote on exec, readFile and writeFile', async () => {
  await withRemotes(async (sys, { rootA }) => {
    assert.equal(sys.handshake.capabilities.remotes, true, 'a provider serving targets says so');
    const a = sys.bindRemote('a');
    const f = path.join(rootA, 'note.txt');
    await a.writeFile(f, 'hello');
    assert.equal(await a.readFile(f), 'hello');
    // Positive routing evidence: only the far side knows which target ran this.
    const r = await a.exec({ shell: 'echo "$CC_REMOTE"' }, { cwd: rootA });
    assert.equal(r.stdout.trim(), 'a');
  });
});

// RE-BASED on card 2026-0312, not deleted: this used to prove the §4 rule
// through a `stdin` frame, which no longer exists. The RULE does — a follow-on
// frame carries no `remoteId` and the `id` is its whole address — so it is
// re-based on `signal`, one of the two follow-on frames that survive.
//
// A LONG command plus a signal that lands on it: the signal frame names no
// remote, and the only way it can reach the right child is through the id the
// `exec` bound. A signal that reached the WRONG target, or none, leaves the
// command running to its own completion and the assertion fails on the code.
//
// NOT CLAIMING anything about process groups (their own capability, own tests).
test('an id is bound to one remote for its whole lifetime — follow-on frames carry none', async () => {
  await withRemotes(async (sys, { rootA }) => {
    const a = sys.bindRemote('a');
    const ac = new AbortController();
    const running = a.exec({ shell: 'sleep 30' }, { cwd: rootA, signal: ac.signal });
    // The `signal`/`close` frames cc sends for this abort name NO remote.
    setTimeout(() => ac.abort(), 150).unref?.();
    const r = await running;
    assert.notEqual(r.code, 0, 'the abort reached the child the exec id named');
    assert.ok(r.durationMs < 20_000, `it was killed rather than left running: ${r.durationMs}ms`);
  });
});

test('ENOREMOTE is id-addressed: one dead remote is not a dead connection', async () => {
  await withRemotes(async (sys, { rootA }) => {
    const a = sys.bindRemote('a');
    const ghost = sys.bindRemote('nope');
    // A real command on a real remote, in flight across the refusal.
    const inFlight = a.exec({ shell: 'sleep 0.4; echo survived' }, { cwd: rootA });
    await assert.rejects(
      () => ghost.readFile(path.join(rootA, 'anything')),
      (e) => expectCode(e, 'ENOREMOTE', 'a request naming a remote the provider does not serve'),
    );
    const r = await inFlight;
    assert.equal(r.stdout.trim(), 'survived',
      'the OTHER target\'s work was untouched — an id-less error would have killed it');
    // And the channel is still usable afterwards.
    assert.equal((await a.exec({ argv: ['printf', 'ok'] }, { cwd: rootA })).stdout, 'ok');
  });
});

test('a request that names NO remote is refused, never answered from a default', async () => {
  await withRemotes(async (sys, { rootA }) => {
    // `sys` itself is unbound. A provider serving many targets has no default,
    // and answering from one would be a misroute reported as success.
    const r = await sys.exec({ argv: ['true'] }, { cwd: rootA });
    assert.equal(r.spawnErrorCode, 'ENOREMOTE');
    assert.equal(r.transportFailure, undefined, 'the far side answered — this is not a dead channel');
  });
});

test('a provider that does not advertise remotes is never handed a remoteId', { skip: CC_SIDE_ONLY }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-noremotes-'));
  const root = await fs.realpath(dir);
  const sys = makeProviderSystem([]);
  try {
    await sys.connect();
    assert.equal(sys.handshake.capabilities.remotes, false);
    const bound = sys.bindRemote('a');
    // cc refuses on its own side rather than sending a field the far side would
    // IGNORE — an ignored remoteId is an operation on the wrong target reported
    // as success.
    const r = await bound.exec({ argv: ['true'] }, { cwd: root });
    assert.equal(r.spawnErrorCode, 'EUNSUPPORTED');
    await assert.rejects(() => bound.readFile(path.join(root, 'x')),
      (e) => expectCode(e, 'EUNSUPPORTED', 'a bound read against a provider with no remotes'));
    await assert.rejects(() => bound.writeFile(path.join(root, 'x'), 'no'),
      (e) => expectCode(e, 'EUNSUPPORTED', 'a bound write against a provider with no remotes'));
    assert.equal(await sys.stat(path.join(root, 'x')), null, 'and nothing was written');
  } finally {
    sys.dispose();
    await rmrf(dir);
  }
});

test('parseFindLines refuses a malformed entry rather than skipping it', () => {
  // `%y\t%m\t%s\t%T@\t%l\t%f` — kind, perms, size, mtime, link target, NAME LAST.
  assert.deepEqual(parseFindLines('f\t644\t3\t1700000000.5\t\ta\nd\t755\t4096\t1700000001\t\tb\n', '/d'), [
    { name: 'a', kind: 'file', size: 3, mode: 0o100644, mtimeMs: 1700000000500, target: null },
    { name: 'b', kind: 'dir', size: 4096, mode: 0o040755, mtimeMs: 1700000001000, target: null },
  ]);
  assert.deepEqual(parseFindLines('l\t777\t7\t1700000000\tsome/where\tlnk\n', '/d'),
    [{ name: 'lnk', kind: 'symlink', size: 7, mode: 0o120777, mtimeMs: 1700000000000, target: 'some/where' }],
    'the target rides the SAME record, so a listing costs one round trip and not 1 + N');
  assert.deepEqual(parseFindLines('p\t644\t0\t1700000000\t\tfifo\n', '/d'),
    [{ name: 'fifo', kind: 'other', size: 0, mode: 0o644, mtimeMs: 1700000000000, target: null }],
    'an entry that is neither file, dir nor symlink is "other", not a parse failure — and carries no type bits');
  // BOTH BOUNDS, because the guard is a field COUNT: a newline gives too few
  // and a tab too many, and either would misattribute a name to another field.
  assert.throws(() => parseFindLines('f\t644\t3\t1\t\tone\nstray line\n', '/d'), (e) => e.code === 'EUNKNOWN');
  assert.throws(() => parseFindLines('f\t644\t3\t1\t\ttwo\ttabs\n', '/d'), (e) => e.code === 'EUNKNOWN');
  // AND THE HOLE THE COUNT CANNOT SEE: a name ending in a newline emits a
  // well-formed record plus an EMPTY line, so it parsed cleanly as the name
  // WITHOUT the newline — colliding with the sibling of that name beside it.
  // A silent mis-naming, which is worse than the dropped entry the rule was
  // written against. Caught by the empty-line position instead.
  assert.throws(() => parseFindLines('f\t644\t3\t1\t\ttrailing\n\nf\t644\t3\t1\t\ttrailing\n', '/d'),
    (e) => e.code === 'EUNKNOWN');
  // …and the control: exactly one trailing terminator is the ordinary case and
  // must still parse, or every listing in the product refuses.
  assert.equal(parseFindLines('f\t644\t3\t1\t\tonly\n', '/d').length, 1);
  assert.equal(parseFindLines('', '/d').length, 0, 'an empty directory is not a parse failure');
  // A field that is present but not a number is a parse failure too, not a NaN
  // that flows into a mirror as a size or a mode.
  assert.throws(() => parseFindLines('f\tzzz\t3\t1\t\ta\n', '/d'), (e) => e.code === 'EUNKNOWN');
  assert.throws(() => parseFindLines('f\t644\tbig\t1\t\ta\n', '/d'), (e) => e.code === 'EUNKNOWN');
});

// ── describeRemote: the mirror advertisement (§2.1) ──────────────────
//
// Outside the per-configuration loop: no configuration in CAPABILITY_CONFIGS
// passes a mirror flag, and the frame's behaviour does not depend on the other
// capabilities. (The count is deliberately not restated here — it moved from
// three to two on card 2026-0312 and the harness owns it.)

// PINS: the frame round-trips, and both halves of the advertisement survive it.
//
// NOT CLAIMING: that every provider implements it. It is a bucket-2 capability
// and its absent-behaviour is the row below.
test('describeRemote round-trips the mirror root and the exclude list', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-mirror-conf-'));
  const root = await fs.realpath(dir);
  const sys = makeProviderSystem(
    ['--mirror', `${FLAG_TARGET}${root}`, '--exclude', `${FLAG_TARGET}/proc`, '--exclude', `${FLAG_TARGET}/dev`]);
  try {
    const hs = await sys.connect();
    assert.equal(hs.capabilities.remoteDescriptors, true);
    assert.deepEqual(await sys.mirror(), { mirrorRoot: root, exclude: ['/proc', '/dev'] });
  } finally { sys.dispose(); await rmrf(dir); }
});

// PINS THE ABSENT-BEHAVIOUR of the capability: a provider that does not
// advertise `remoteDescriptors` is never sent the frame and answers nothing.
//
// NOT CLAIMING: the wire-level absence — that is measured with the recording
// provider in tests/systems-mirror-fallback.test.mjs. This is the cc-side
// contract the rest of the code reads.
test('a provider without the capability advertises no mirror', { skip: CC_SIDE_ONLY }, async () => {
  const sys = makeProviderSystem([]);
  try {
    assert.equal((await sys.connect()).capabilities.remoteDescriptors, false);
    assert.deepEqual(await sys.mirror(), { mirrorRoot: null, exclude: [] });
  } finally { sys.dispose(); }
});

// PINS: an unknown remote's describeRemote is answered ENOREMOTE and
// ID-ADDRESSED — one dead target must not tear down the connection every other
// target's work is on (§9).
//
// NOT CLAIMING: that a second remote's operation is in flight at that instant;
// tests/systems-mirror-advertisement.test.mjs asserts the surviving connection.
test('describeRemote for an unknown remote is an id-addressed ENOREMOTE', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-mirror-conf-'));
  const root = await fs.realpath(dir);
  const sys = makeProviderSystem(['--remote', `a=${root}`, '--mirror', `a=${root}`]);
  try {
    await sys.connect();
    await assert.rejects(() => sys.bindRemote('ghost').mirror(),
      (e) => expectCode(e, 'ENOREMOTE', 'describeRemote for an unknown remote'));
    // The connection is still serving the target that does exist.
    assert.deepEqual(await sys.bindRemote('a').mirror(), { mirrorRoot: root, exclude: [] });
  } finally { sys.dispose(); await rmrf(dir); }
});

// PINS THE EXTENSION POINT a later card will rely on: a `remoteDescriptor`
// carrying a field cc does not know about is accepted and the field ignored.
// Pinned so a future reader cannot "tighten" it away — a provider→cc field is
// inert on arrival, which is what makes growing this frame safe without a
// version bump.
//
// NOT CLAIMING: that any particular field name is reserved. The fixture uses a
// neutral one.
test('an unrecognised field on a remoteDescriptor is ignored, not an error', async () => {
  const fixture = path.join(
    path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'mirrorFixtureProvider.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-extrafield-'));
  const frameLog = path.join(dir, 'frames.jsonl');
  const sys = new (await import('../src/systems/providerSystem.ts')).ProviderSystem({
    id: 'extra',
    launch: {
      argv: ['node', fixture, '--advertise-mirror', '/srv', '--advertise-exclude', '/srv/tmp',
        '--extra-field', '--frame-log', frameLog],
    },
  });
  try {
    assert.equal((await sys.connect()).capabilities.remoteDescriptors, true);
    assert.deepEqual(await sys.mirror(), { mirrorRoot: '/srv', exclude: ['/srv/tmp'] });
  } finally { sys.dispose(); }
  // THE FIELD WAS ACTUALLY SENT. Without this the assertion above passes just as
  // well against a fixture that stopped adding the field, which would leave the
  // extension point unpinned while looking covered.
  const sent = (await fs.readFile(frameLog, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const descriptor = sent.find(f => f.type === 'remoteDescriptor');
  assert.ok(descriptor, 'the fixture answered describeRemote');
  assert.deepEqual(descriptor.somethingCcHasNeverHeardOf, { nested: [1, 2, 3] },
    'the unrecognised field really crossed the wire');
  await rmrf(dir);
});

test('a write above the protocol cap is refused before a byte reaches the wire', async () => {
  // Outside the per-configuration loop: this allocates the cap, and the refusal
  // is cc-side, identical whatever the provider advertises.
  const sys = makeProviderSystem([]);
  try {
    await sys.connect();
    await assert.rejects(() => sys.writeFile(path.join(os.tmpdir(), 'cc-never-written'), 'a'.repeat(MAX_FILE_BYTES + 1)),
      (e) => expectCode(e, 'EFBIG', 'a write past the per-file cap'));
    assert.equal(await sys.stat(path.join(os.tmpdir(), 'cc-never-written')), null, 'nothing was written');
  } finally { sys.dispose(); }
});

// ── The third-party contract (card 2026-0313) ────────────────────────

// PINS: `CC_CONFORMANCE_REMOTE_ID` binds every fixture handle to that target,
// an explicit `{ remoteId: null }` still beats it, and the binding rides the
// WIRE rather than only the handle. Without it a provider that serves only
// named targets answers the core battery `ENOREMOTE` under the protocol's own
// §8 rule — the lockout docs/systems-protocol.md §10 names.
//
// NOT CLAIMING: that a bound run proves as much as the reference run. It does
// not, and §10 says which rows it gives up.
//
// Reference-only: it asserts the UNSET default, which a third-party run has
// deliberately changed.
test('CC_CONFORMANCE_REMOTE_ID binds the fixture handle, and an explicit remoteId still wins',
  { skip: IS_REFERENCE_PROVIDER ? false : 'asserts the unset default' }, async () => {
    const before = process.env[REMOTE_ID_ENV];
    assert.equal(makeProviderSystem([]).remoteId, null, 'unset: the fixture handle is unbound');
    process.env[REMOTE_ID_ENV] = 't';
    try {
      assert.equal(makeProviderSystem([]).remoteId, 't', 'set: every fixture handle is bound to it');
      assert.equal(makeProviderSystem([], { remoteId: null }).remoteId, null,
        'an explicit remoteId beats the env var — what keeps the remotes fixtures unbound');
      const sys = makeProviderSystem(['--remote', 't=/']);
      try {
        await sys.connect();
        const r = await sys.exec({ shell: 'echo "$CC_REMOTE"' }, { cwd: os.tmpdir() });
        assert.equal(r.stdout.trim(), 't', 'the binding reached the far side, not just the handle');
      } finally { sys.dispose(); }
    } finally {
      if (before === undefined) delete process.env[REMOTE_ID_ENV];
      else process.env[REMOTE_ID_ENV] = before;
    }
  });

// PINS `conformanceRemoteId()`'s WHITESPACE CONTRACT — the only normalisation
// between the env var and `ProviderSystem`, which does none of its own.
//
// MEASURED: `opts.remoteId ?? null` keeps `''` (not nullish), so a handle built
// from a blank id binds to a nonsense target and every operation comes back
// `EUNSUPPORTED` — a whole battery of opaque failures from
// `CC_CONFORMANCE_REMOTE_ID=$SOME_UNSET_VAR` in a CI script, which is the exact
// failure mode this contract exists to remove, aimed at its own audience.
//
// The blank cases are what `.trim()` kills; the empty case is what `|| null`
// kills where `?? null` would not; `'  t  '` kills a trim that only tests and
// does not apply.
//
// Pure: reads the variable, launches nothing.
test('an empty or blank CC_CONFORMANCE_REMOTE_ID is unbound, never bound to a nonsense target', () => {
  const before = process.env[REMOTE_ID_ENV];
  try {
    for (const blank of ['', ' ', '  \t ', '\n']) {
      process.env[REMOTE_ID_ENV] = blank;
      assert.equal(conformanceRemoteId(), null, `${JSON.stringify(blank)} must not bind a handle`);
    }
    process.env[REMOTE_ID_ENV] = '  t  ';
    assert.equal(conformanceRemoteId(), 't', 'a real id is TRIMMED, not passed through padded');
    delete process.env[REMOTE_ID_ENV];
    assert.equal(conformanceRemoteId(), null, 'unset is unbound — the default every in-repo run takes');
  } finally {
    if (before === undefined) delete process.env[REMOTE_ID_ENV];
    else process.env[REMOTE_ID_ENV] = before;
  }
});

// PINS THE BOUND-RUN PRECONDITION (§10 of docs/systems-protocol.md): a run bound
// with CC_CONFORMANCE_REMOTE_ID against a provider that does not advertise
// `remotes` is refused AT THE HANDSHAKE, with a message naming the flag that
// fixes it and the id it must carry — instead of through the run of bare value
// diffs cc's client-side refusal would otherwise produce.
//
// Deleting the guard, inverting its condition, dropping the bound id from the
// message, or firing it on an UNBOUND run each fail this.
//
// Pure: it drives the assertion directly, launching no provider.
test('a bound run is refused at the handshake unless the provider serves that target', () => {
  const before = process.env[REMOTE_ID_ENV];
  const config = CAPABILITY_CONFIGS[0];
  // HERMETIC in both directions: the ambient variable is cleared first, because
  // this file is itself run bound (that is the whole point of it), and an
  // "unbound" assertion made while it is set would assert the wrong thing.
  delete process.env[REMOTE_ID_ENV];
  try {
    // UNBOUND is untouched: this very handshake is what the default run asserts.
    assertNegotiatedCapabilities(config.caps, config, true);
    process.env[REMOTE_ID_ENV] = 't';
    assert.throws(() => assertNegotiatedCapabilities(config.caps, config, true),
      /--remote t=<absolute root>/, 'the refusal names the flag AND the bound id');
    // A provider that DOES serve the target is entirely unaffected by the guard.
    assertNegotiatedCapabilities({ ...config.caps, remotes: true }, config, false);
  } finally {
    if (before === undefined) delete process.env[REMOTE_ID_ENV];
    else process.env[REMOTE_ID_ENV] = before;
  }
});

// PINS: the third-party half of the capability assertion relaxes EXACTLY one
// axis. `remotes`/`remoteDescriptors` may be a superset of the matrix, every
// capability the matrix TOGGLES must still match, and the reference half stays
// exact — so a relaxation cannot leak onto the default run.
//
// Pure: it drives the assertion directly, launching no provider.
test('the third-party capability assertion tolerates a superset but pins the toggle', () => {
  for (const config of CAPABILITY_CONFIGS) {
    const superset = { ...config.caps, remotes: true, remoteDescriptors: true };
    assertNegotiatedCapabilities(superset, config, false);
    assert.throws(() => assertNegotiatedCapabilities(superset, config, true), assert.AssertionError,
      'the reference provider is still held to the exact set');
    for (const cap of TOGGLED_CAPABILITIES) {
      assert.throws(
        () => assertNegotiatedCapabilities({ ...superset, [cap]: !config.caps[cap] }, config, false),
        assert.AssertionError, `${cap} is pinned for a third-party provider too`);
    }
  }
});

// ── Completeness ─────────────────────────────────────────────────────

test('every code in the taxonomy is produced by a real failure somewhere in this suite',
  // Reference-only, and NOT a statement about the provider: `produced` is filled
  // by the rows that RAN, and a third-party run skips the cc-side ones above —
  // so the union is short by exactly their codes whatever the provider does.
  { skip: IS_REFERENCE_PROVIDER ? false : 'counts producers across rows a third-party run skips' },
  () => {
  // The codes this file provokes live, plus the ones whose failure modes belong
  // to another file. Naming the file is the point: a code added to the protocol
  // with nowhere to produce it fails here.
  const elsewhere = {
    EPROTO: 'tests/systems-protocol-codec.test.mjs + tests/systems-provider-supervision.test.mjs',
    ETRANSPORT: 'tests/systems-provider-supervision.test.mjs',
    ETIMEDOUT: 'tests/systems-provider-supervision.test.mjs + tests/systems-shell-framing.test.mjs',
    ESHELLGONE: 'tests/systems-shell-framing.test.mjs',
    ECANCELLED: 'tests/systems-shell-framing.test.mjs + tests/systems-tool-redirect.test.mjs',
    // The one code no test can provoke without filling a disk; its classifier
    // row is asserted in tests/systems-protocol-codec.test.mjs.
    ENOSPC: 'tests/systems-protocol-codec.test.mjs (classifier only)',
  };
  const covered = new Set([...produced, ...Object.keys(elsewhere)]);
  const all = [...PROTOCOL_ERROR_CODES, ...FS_ERROR_CODES];
  assert.deepEqual(all.filter(c => !covered.has(c)), [], 'every named code must have a producer');
  assert.deepEqual(Object.keys(elsewhere).filter(c => !all.includes(c)), [],
    'and the cross-reference must not name a code the taxonomy no longer has');
});
