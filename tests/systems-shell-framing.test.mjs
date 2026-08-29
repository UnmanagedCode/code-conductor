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
  beginFor, frameCommand, newNonce, parseFramedStderr, parseFramedStdout, sentinelFor,
} from '../src/systems/shellFraming.ts';
import { makeProviderSystem } from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';

// The opening sentinel exactly as the framed script emits it — INCLUDING the
// injected leading newline, without which the marker glues itself to whatever
// the shell printed before it. Everything before it belongs to the shell, so a
// parser test that omits it is testing a stream that could never occur.
const B = (n) => `\n${beginFor(n)}\n`;

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
  const text = `${B(n)}out\n${s} 7 ${Buffer.from('/a').toString('base64')}\ntrailing\n${s} 9 ${Buffer.from('/b').toString('base64')}\n`;
  const m = parseFramedStdout(text, n);
  assert.equal(m.code, 7, 'the FIRST sentinel is the boundary');
  assert.equal(m.cwd, '/a');
  assert.equal(m.text, 'out');
});

test('a sentinel that does not start a line is output, not a boundary', () => {
  const n = 'abc';
  const s = sentinelFor(n);
  const good = `${s} 0 ${Buffer.from('/x').toString('base64')}`;
  const m = parseFramedStdout(`${B(n)}prefix ${s} 5 xxx\n${good}\n`, n);
  assert.equal(m.code, 0);
  assert.equal(m.text, `prefix ${s} 5 xxx`);
});

test('cc strips exactly the one newline it injected', () => {
  const n = 'abc';
  const s = sentinelFor(n);
  const b64 = Buffer.from('/x').toString('base64');
  assert.equal(parseFramedStdout(`${B(n)}\n${s} 0 ${b64}\n`, n).text, '',
    'a command with no output has empty stdout, not a blank line');
  assert.equal(parseFramedStdout(`${B(n)}hi\n${s} 0 ${b64}\n`, n).text, 'hi',
    'output without a trailing newline is not given one');
  assert.equal(parseFramedStdout(`${B(n)}hi\n\n${s} 0 ${b64}\n`, n).text, 'hi\n',
    "output WITH a trailing newline keeps it — only cc's own newline goes");
});

test('the sentinel line is not a boundary until it is complete', () => {
  const n = 'abc';
  const s = sentinelFor(n);
  assert.equal(parseFramedStdout(`${B(n)}out\n${s} 0 eHg`, n), null, 'a half-arrived sentinel line is not yet a frame');
  assert.equal(parseFramedStdout(`${B(n)}out\n`, n), null);
  assert.equal(parseFramedStderr(`${B(n)}err\n`, n), null);
  // And nothing is a frame until the OPENING sentinel has arrived: until then
  // every byte on the stream is the shell's, not the command's.
  assert.equal(parseFramedStdout(`banner\n${s} 0 eHg=\n`, n), null,
    'a closing sentinel before the opening one is not a boundary');
  assert.equal(parseFramedStderr(`banner\n${s}\n`, n), null);
});

test('the cwd survives spaces and newlines because it rides as base64', () => {
  const n = 'abc';
  const weird = '/tmp/a dir/with\nnewline';
  const m = parseFramedStdout(`${B(n)}\n${sentinelFor(n)} 0 ${Buffer.from(weird).toString('base64')}\n`, n);
  assert.equal(m.cwd, weird);
});

test('the nonce is fresh per command, and the script keeps cd and export in the shell', () => {
  assert.notEqual(newNonce(), newNonce(), 'a fixed nonce is forgeable — that is the measured desync');
  assert.match(newNonce(), /^[0-9a-f]{32}$/, '128 bits');
  const script = frameCommand('N', 'echo hi');
  assert.ok(script.startsWith(String.raw`printf '\n__CC_N_BEGIN__\n'; printf '\n__CC_N_BEGIN__\n' >&2`),
    'the opening sentinel is emitted on BOTH streams before the command runs, each newline-prefixed');
  assert.match(script, /\{ echo hi\n\} < \/dev\/null\n/, 'braces, not a subshell, so cd and export land in the shell');
  assert.match(script, /< \/dev\/null/, 'the command group gets a closed stdin, like project_bash and the Bash tool');
  assert.ok(script.includes(String.raw`printf '\n__CC_N__\n' >&2`),
    'stderr carries its own sentinel, newline-prefixed like stdout\'s, so a command whose stderr has no trailing newline still frames');
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
      // NEITHER stream may assume a trailing newline. `printf err >&2` is
      // ordinary, and a stderr sentinel that landed mid-line would never match
      // — the command would wedge until its deadline instead of returning.
      const bare = await sh.run('printf out-no-nl; printf err-no-nl >&2', { timeoutMs: 4_000 });
      assert.equal(bare.stdout, 'out-no-nl');
      assert.equal(bare.stderr, 'err-no-nl');
      assert.equal(bare.code, 0);
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

  test(`[${mode.name}] a shell that cannot START says why — ENOENT, not "the shell died"`, async () => {
    await withShell(mode.flags, async (sh, cwd) => {
      assert.equal((await sh.run('echo before')).stdout, 'before\n');
      // The cwd goes away under the shell. A one-shot opens a new shell for
      // every command, so it hits this immediately; a persistent one hits it on
      // its next RESET, which is why the shell is killed first.
      if (mode.persistent) await assert.rejects(() => sh.run('exit 0'), (e) => e.code === 'ESHELLGONE');
      await rmrf(cwd);
      await assert.rejects(() => sh.run('echo after'), (e) => {
        assert.equal(e.code, 'ENOENT', `expected ENOENT, got ${e.code}: ${e.message}`);
        return true;
      });
    });
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

// What the framed script's `printf` statements will actually put on each
// stream, read back OUT of the script rather than restated.
//
// A fixture that hard-codes the framing it believes the code emits silently
// stops testing that framing the moment it changes — and the framing's whole
// subtlety is which sentinels carry an injected leading newline, which is
// exactly what a hard-coded fixture would supply for free. Deriving it means a
// script that stopped newline-prefixing a marker produces a fake stream where
// the marker is glued to whatever preceded it, as a real shell would.
//
// The trailing context stops at `;` as well as at a newline: both opening
// sentinels are one statement apart on one line, and only the second is
// redirected.
function shellEmissions(script) {
  const out = [], err = [];
  for (const m of script.matchAll(/printf '([^']*)'([^\n;]*)/g)) {
    (m[2].includes('>&2') ? err : out).push(m[1].replace(/\\n/g, '\n'));
  }
  assert.deepEqual([out.length, err.length], [2, 2],
    `the framed script must emit an opening and a closing sentinel on each stream; got ${JSON.stringify({ out, err })}`);
  return { out, err };
}

function fakeHost({ banner = '', bannerErr = '', respond }) {
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
      // A login shell sources its profile when it STARTS, which is after cc has
      // written the first command into its stdin — so the banner arrives ahead
      // of that command's opening sentinel, not before the shell is usable.
      // Emitting it at openStream time instead would land it while cc is not
      // reading, where it is discarded and proves nothing.
      let pendingBanner = { out: banner, err: bannerErr };
      state.stream = {
        write(script) {
          const nonce = /__CC_([0-9a-f]+)_BEGIN__/.exec(script)[1];
          const command = /\{ ([\s\S]*?)\n\} < \/dev\/null\n/.exec(script)[1];
          state.commands.push(command);
          const r = respond(command, nonce) ?? {};
          if (r.silent) return;
          const pre = pendingBanner;
          pendingBanner = { out: '', err: '' };
          // Byte-for-byte what a shell running this script would produce:
          // opening sentinel, the command's output, closing sentinel — with the
          // closing stdout one's `%d %s` filled in as the shell would fill them.
          const { out, err } = shellEmissions(script);
          const closingOut = out[1]
            .replace('%d', String(r.code ?? 0))
            .replace('%s', Buffer.from(r.cwd ?? '/w').toString('base64'));
          setImmediate(() => emit(
            `${pre.out}${out[0]}${r.stdout ?? ''}${closingOut}`,
            `${pre.err}${err[0]}${r.stderr ?? ''}${err[1]}`,
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

test('a banner with NO trailing newline still frames — on both streams', async () => {
  // The opening sentinel has to START a line just as the closing ones do. A
  // profile that writes an unterminated banner ('printf MOTD') otherwise glues
  // itself to the marker, which then never matches: the command wedges to its
  // deadline. And in persistent mode the reset reopens the same login shell,
  // which reprints the same banner — so it is a LOOP, one wedge per command,
  // for the life of the session.
  for (const stream of ['stdout', 'stderr']) {
    const { host } = fakeHost({
      banner: stream === 'stdout' ? 'UNTERMINATED-MOTD' : '',
      bannerErr: stream === 'stderr' ? 'UNTERMINATED-MOTD' : '',
      respond: () => ({ stdout: 'out', stderr: 'err' }),
    });
    const sh = new ProviderShell(host, { cwd: '/w', commandTimeoutMs: 300 });
    const r = await sh.run('echo real');
    assert.equal(r.stdout, 'out', `${stream}: an unterminated banner must not swallow the marker`);
    assert.equal(r.stderr, 'err', stream);
    assert.equal(r.code, 0, stream);
  }
});

test('a login shell\'s banner is never attributed to a command, on either stream', async () => {
  // `$SHELL -l` sources profile files, and anything they print lands on the
  // stream before the first command's output. The OPENING sentinel is what
  // separates the two: everything before it is the shell's.
  const { host, state } = fakeHost({
    banner: 'Welcome to the box!\nMOTD line two\n',
    bannerErr: 'nvm: something on stderr\n',
    respond: () => ({ stdout: 'real output', stderr: 'real error' }),
  });
  const sh = new ProviderShell(host, { cwd: '/w' });
  const r = await sh.run('echo real');
  assert.deepEqual(state.commands, ['echo real'],
    'the only thing written is the command itself — no priming round trip');
  assert.equal(r.stdout, 'real output', "the banner is not the command's stdout");
  assert.equal(r.stderr, 'real error', "and its stderr half is not the command's stderr");
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
  // …and cc STOPS claiming it lost state. The reason is recorded so a reconnect
  // can say so once; a sticky one becomes a permanent false "I lost your cwd"
  // on a shell that has been working for hours.
  assert.equal(sh.resetReason, null,
    'a successful reconnect clears the reset reason it reported');
  assert.equal(sh.open, true, 'and the shell is open again');
});
