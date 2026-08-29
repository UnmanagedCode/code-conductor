// The redirected shell's framing — the piece cc owns, and the piece a real
// probe broke.
//
// Driving a real `bash -l` with `{ <cmd>\n} < /dev/null` plus a sentinel
// carrying `$?` and base64 `$PWD` was MEASURED to work — `cd` persisted,
// `export` persisted, exit codes were captured, stderr carried its own sentinel
// — and MEASURED to break: a command that echoed the sentinel desynchronised
// the parser, five stdout frames for four commands, the forgery parsed as
// `rc=999`. Everything below replays one of those findings.
//
// EVERY end-to-end case runs in BOTH capability modes. The `persistentShell`
// fallback is not a flag, it is a code path, and a fallback that has never run
// is not a fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderShell } from '../src/systems/providerShell.ts';
import {
  frameCommand, newNonce, parseFramedStderr, parseFramedStdout, sentinelFor,
} from '../src/systems/shellFraming.ts';
import { makeProviderSystem } from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';

const MODES = [
  { name: 'persistent shell', flags: [], persistent: true },
  { name: 'persistentShell:false fallback', flags: ['--no-persistent-shell'], persistent: false },
];

async function withShell(flags, fn, shellOpts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-shell-'));
  const cwd = await fs.realpath(dir);
  const sys = makeProviderSystem(flags);
  try {
    await sys.connect();
    return await fn(sys.shell({ cwd, ...shellOpts }), cwd);
  } finally {
    sys.dispose();
    await rmrf(dir);
  }
}

// ── The parser, on its own ───────────────────────────────────────────

test('FIRST MATCH WINS: a second sentinel line cannot move the boundary', () => {
  // The rule that confines a desync to one command. Without it the measured
  // probe produced five frames for four commands.
  const n = 'abc';
  const s = sentinelFor(n);
  const text = `out\n${s} 7 ${Buffer.from('/a').toString('base64')}\ntrailing\n${s} 9 ${Buffer.from('/b').toString('base64')}\n`;
  const m = parseFramedStdout(text, n);
  assert.equal(m.code, 7, 'the FIRST sentinel is the boundary');
  assert.equal(m.cwd, '/a');
  assert.equal(m.text, 'out');
});

test('a sentinel that does not start a line is output, not a boundary', () => {
  const n = 'abc';
  const s = sentinelFor(n);
  const good = `${s} 0 ${Buffer.from('/x').toString('base64')}`;
  const m = parseFramedStdout(`prefix ${s} 5 xxx\n${good}\n`, n);
  assert.equal(m.code, 0);
  assert.equal(m.text, `prefix ${s} 5 xxx`);
});

test('cc strips exactly the one newline it injected', () => {
  const n = 'abc';
  const s = sentinelFor(n);
  const b64 = Buffer.from('/x').toString('base64');
  assert.equal(parseFramedStdout(`\n${s} 0 ${b64}\n`, n).text, '',
    'a command with no output has empty stdout, not a blank line');
  assert.equal(parseFramedStdout(`hi\n${s} 0 ${b64}\n`, n).text, 'hi',
    'output without a trailing newline is not given one');
  assert.equal(parseFramedStdout(`hi\n\n${s} 0 ${b64}\n`, n).text, 'hi\n',
    "output WITH a trailing newline keeps it — only cc's own newline goes");
});

test('the sentinel line is not a boundary until it is complete', () => {
  const n = 'abc';
  const s = sentinelFor(n);
  assert.equal(parseFramedStdout(`out\n${s} 0 eHg`, n), null, 'a half-arrived sentinel line is not yet a frame');
  assert.equal(parseFramedStdout('out\n', n), null);
  assert.equal(parseFramedStderr('err\n', n), null);
});

test('the cwd survives spaces and newlines because it rides as base64', () => {
  const n = 'abc';
  const weird = '/tmp/a dir/with\nnewline';
  const m = parseFramedStdout(`\n${sentinelFor(n)} 0 ${Buffer.from(weird).toString('base64')}\n`, n);
  assert.equal(m.cwd, weird);
});

test('the nonce is fresh per command, and the script keeps cd and export in the shell', () => {
  assert.notEqual(newNonce(), newNonce(), 'a fixed nonce is forgeable — that is the measured desync');
  assert.match(newNonce(), /^[0-9a-f]{32}$/, '128 bits');
  const script = frameCommand('N', 'echo hi');
  assert.match(script, /^\{ echo hi\n\} < \/dev\/null\n/, 'braces, not a subshell, so cd and export land in the shell');
  assert.match(script, /< \/dev\/null/, 'the command group gets a closed stdin, like project_bash and the Bash tool');
  assert.match(script, /__CC_N__\\n' >&2/, 'stderr carries its own sentinel so cc knows both streams are done');
});

// ── End to end, in both capability modes ─────────────────────────────

for (const mode of MODES) {
  test(`[${mode.name}] cd persists across commands, read back from the shell`, async () => {
    await withShell(mode.flags, async (sh, cwd) => {
      assert.equal(sh.persistent, mode.persistent, 'the mode under test is the one negotiated');
      const a = await sh.run('cd /tmp; echo one');
      assert.equal(a.stdout, 'one\n');
      assert.equal(a.cwd, '/tmp');
      const b = await sh.run('pwd');
      assert.equal(b.stdout.trim(), '/tmp', 'the SECOND command started where the first ended');
      assert.equal(sh.cwd, '/tmp');
      // Not parsed out of the command text: the cwd comes back from the shell's
      // own $PWD, so an indirect cd is tracked just as well.
      const c = await sh.run(`d=${cwd}; cd "$d"`);
      assert.equal(c.cwd, cwd);
    });
  });

  test(`[${mode.name}] export persists ONLY with a persistent shell — the documented fallback difference`, async () => {
    await withShell(mode.flags, async (sh) => {
      await sh.run('export CC_PROBE=set-by-first');
      const r = await sh.run('echo "[$CC_PROBE]"');
      if (mode.persistent) {
        assert.equal(r.stdout.trim(), '[set-by-first]', 'a long-lived shell carries exports — better than the local CLI');
      } else {
        assert.equal(r.stdout.trim(), '[]',
          'the fallback carries cwd but not exports — exactly the local CLI\'s own behaviour, so this is parity, not breakage');
      }
    });
  });

  test(`[${mode.name}] exit codes are captured, and stderr is routed with its own sentinel`, async () => {
    await withShell(mode.flags, async (sh) => {
      const ok = await sh.run('echo fine');
      assert.equal(ok.code, 0);
      const bad = await sh.run('ls /definitely-not-here');
      assert.equal(bad.code, 2, 'the real exit code, not a guess');
      assert.equal(bad.stdout, '');
      assert.match(bad.stderr, /definitely-not-here/);
      assert.equal(bad.stderr.includes('__CC_'), false, 'no sentinel text leaks into stderr');
      // A SUBSHELL, not a bare `exit`: `{ exit 42\n}` would exit the shell
      // itself, which is the ESHELLGONE case below rather than an exit code.
      const explicit = await sh.run('echo out; echo err >&2; (exit 42)');
      assert.equal(explicit.code, 42);
      assert.equal(explicit.stdout, 'out\n');
      assert.equal(explicit.stderr, 'err\n');
      assert.equal(explicit.stdout.includes('__CC_'), false, 'no sentinel text leaks into stdout');
    });
  });

  test(`[${mode.name}] a STALE sentinel echoed by a later command does not desync the stream`, async () => {
    await withShell(mode.flags, async (sh) => {
      // The measured failure: with a fixed nonce, a command that printed the
      // sentinel was parsed as a frame boundary (rc=999) and every command after
      // it was attributed to the wrong frame. A fresh nonce per command means
      // the stale one is just text.
      const first = await sh.run('echo real');
      assert.equal(first.code, 0);
      const forged = await sh.run('echo "__CC_deadbeefdeadbeefdeadbeefdeadbeef__ 999 Lw=="; echo after; (exit 3)');
      assert.equal(forged.code, 3, 'the forged rc=999 is not the command\'s exit code');
      assert.match(forged.stdout, /999/, 'the forgery is ordinary output of the command that printed it');
      assert.match(forged.stdout, /after/, "and it does not truncate the command's own later output");
      const next = await sh.run('echo still-aligned');
      assert.equal(next.stdout, 'still-aligned\n', 'the NEXT command is still framed correctly');
      assert.equal(next.code, 0);
    });
  });

  test(`[${mode.name}] a command that exits the shell surfaces ESHELLGONE, and the next one works`, async () => {
    await withShell(mode.flags, async (sh) => {
      await assert.rejects(() => sh.run('exit 7'), (e) => {
        assert.equal(e.code, 'ESHELLGONE', `expected ESHELLGONE, got ${e.code}: ${e.message}`);
        return true;
      });
      assert.equal(sh.open, false, 'the dead shell is dropped rather than reused');
      const after = await sh.run('echo recovered');
      assert.equal(after.stdout, 'recovered\n', 'the shell is re-established on the next command');
    });
  });

  test(`[${mode.name}] an unterminated quote settles inside its deadline instead of hanging`, async () => {
    await withShell(mode.flags, async (sh) => {
      // The other wedge mode. With a live shell it is a genuine hang — the shell
      // sits reading a continuation line that will never come — so the per-
      // command deadline fires and the shell is RESET. Without one, the same
      // script never parses, so bash dies before the framing runs.
      const started = Date.now();
      await assert.rejects(() => sh.run("echo 'unterminated", { timeoutMs: 400 }), (e) => {
        assert.equal(e.code, mode.persistent ? 'ETIMEDOUT' : 'ESHELLGONE', `got ${e.code}: ${e.message}`);
        return true;
      });
      assert.ok(Date.now() - started < 5_000, 'it must not hang forever');
      const after = await sh.run('echo alive');
      assert.equal(after.stdout, 'alive\n', 'the reset shell takes the next command');
    }, { commandTimeoutMs: 400 });
  });

  test(`[${mode.name}] cc serialises per shell, and a wait past its bound is EBUSY`, async () => {
    await withShell(mode.flags, async (sh) => {
      const slow = sh.run('sleep 0.5; echo slow');
      await assert.rejects(() => sh.run('echo fast'), (e) => {
        assert.equal(e.code, 'EBUSY', `got ${e.code}: ${e.message}`);
        return true;
      });
      assert.equal((await slow).stdout, 'slow\n', 'the command that held the shell still completes');
    }, { busyWaitMs: 30 });
  });
}

// ── The two cases a real shell cannot be made to produce on demand ───
//
// Driven through a fake ShellHost, which is the seam ProviderShell was given so
// these do not depend on which login shell the box happens to have.

function fakeHost({ banner = '', respond }) {
  const state = { commands: [], stream: null };
  const host = {
    capabilities: { persistentShell: true, processGroupSignal: true },
    descriptor: { os: 'linux', pathSep: '/', shell: '/bin/bash', home: '/root' },
    execOneShot() { throw new Error('not used'); },
    async openStream(_spec, _opts, handlers) {
      const emit = (out, err) => {
        if (out) handlers.onStdout(Buffer.from(out, 'utf8'));
        if (err) handlers.onStderr(Buffer.from(err, 'utf8'));
      };
      if (banner) emit(banner, '');
      state.stream = {
        write(script) {
          const nonce = /__CC_([0-9a-f]+)__/.exec(script)[1];
          const command = /^\{ ([\s\S]*?)\n\} < \/dev\/null\n/.exec(script)[1];
          state.commands.push(command);
          const r = respond(command, nonce) ?? {};
          if (r.silent) return;
          const s = sentinelFor(nonce);
          setImmediate(() => emit(
            `${r.stdout ?? ''}\n${s} ${r.code ?? 0} ${Buffer.from(r.cwd ?? '/w').toString('base64')}\n`,
            `${r.stderr ?? ''}${s}\n`,
          ));
        },
        close() {},
        retain() {},
        release() {},
      };
      return state.stream;
    },
  };
  return { host, state };
}

test('a login shell\'s banner is absorbed by the prime, never attributed to a command', async () => {
  // `$SHELL -l` sources profile files, and anything they print lands on the
  // stream before the first command's output. One discarded framed no-op eats
  // it.
  const { host, state } = fakeHost({
    banner: 'Welcome to the box!\nMOTD line two\n',
    respond: (cmd) => ({ stdout: cmd === ':' ? '' : 'real output' }),
  });
  const sh = new ProviderShell(host, { cwd: '/w' });
  const r = await sh.run('echo real');
  assert.equal(state.commands[0], ':', 'the first thing written is the discarded prime');
  assert.equal(r.stdout, 'real output', 'the banner is not the command\'s stdout');
  assert.equal(r.stdout.includes('Welcome'), false);
});

test('a forgery of the LIVE nonce truncates only its own output — the desync cannot propagate', async () => {
  // A real command cannot guess a 128-bit per-command nonce, so this is the
  // worst case made reachable: the forgery wins the first match, the command
  // reports the forged rc, and the very next command is still correctly framed.
  const s = (n) => sentinelFor(n);
  const { host } = fakeHost({
    respond: (cmd, nonce) => cmd === 'forge'
      ? { stdout: `before\n${s(nonce)} 99 ${Buffer.from('/forged').toString('base64')}\nafter`, code: 0 }
      : { stdout: cmd },
  });
  const sh = new ProviderShell(host, { cwd: '/w' });
  const forged = await sh.run('forge');
  assert.equal(forged.code, 99, 'first match wins: the forgery IS the boundary for its own command');
  assert.equal(forged.stdout, 'before', 'and it truncated only its own output');
  const next = await sh.run('echo next');
  assert.equal(next.stdout, 'echo next', 'the following command is unaffected');
  assert.equal(next.code, 0);
});

test('a command whose sentinel never arrives times out and RESETS the shell', async () => {
  let closed = 0;
  const { host } = fakeHost({ respond: (cmd) => (cmd === 'wedge' ? { silent: true } : { stdout: cmd }) });
  const origOpen = host.openStream;
  host.openStream = async (spec, opts, handlers) => {
    const s = await origOpen(spec, opts, handlers);
    return { ...s, close: () => { closed++; } };
  };
  const sh = new ProviderShell(host, { cwd: '/w', commandTimeoutMs: 50 });
  await assert.rejects(() => sh.run('wedge'), (e) => e.code === 'ETIMEDOUT');
  assert.equal(closed, 1, 'the wedged shell is closed, not left holding the next command');
  assert.equal(sh.open, false);
  assert.match(sh.resetReason, /deadline/, 'the reason is recorded so a reconnect can SAY it lost its state');
  const after = await sh.run('echo back');
  assert.equal(after.stdout, 'echo back');
});
