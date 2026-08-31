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
  FramedStreamFilter, beginFor, frameCommand, newNonce,
  parseFramedStderr, parseFramedStdout, sentinelFor,
} from '../src/systems/shellFraming.ts';
import { makeProviderSystem } from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';
import { waitFor } from './helpers.mjs';

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

// PINS: closing a shell while a command is in flight FAILS that command. A
// close that lands mid-command — an interrupt, an idle sweep — must not drop
// the in-flight request, or its caller awaits a promise nothing will settle and
// the session wedges with no error anywhere.
test('closing a shell mid-command fails the command instead of dropping it', async () => {
  await withShell([], async (shell) => {
    const running = shell.run('sleep 30');
    // Let the command reach the shell before the close, so the pending request
    // really is in flight rather than not yet written.
    await new Promise(r => setTimeout(r, 50));
    await shell.close();
    await assert.rejects(running, (e) => {
      assert.equal(e.code, 'ESHELLGONE');
      return true;
    });
  });
});

// ── Streaming the same frame, without leaking it ─────────────────────
//
// A redirected Bash must show its output as it arrives, which means forwarding
// bytes BEFORE the frame boundary has been seen. FramedStreamFilter is the one
// piece that makes that safe, and the only property that matters is that it
// agrees with the parser exactly: whatever it emits, concatenated, must be the
// same string the parser would have produced from the whole stream at the end.
//
// The framing itself is UNCHANGED. Everything below is derived from rules the
// parser already has — nothing before the opening sentinel is the command's,
// the closing sentinel must start a line, first match wins, and cc's injected
// newline is stripped — so the streaming path cannot drift from the buffered
// one without one of these failing.

// Every way a stream can be cut into chunks, for a handful of representative
// splits: one byte at a time (the worst case for a partial sentinel), and every
// single cut point.
function* splittings(text) {
  yield [...text];                                  // byte by byte
  for (let i = 0; i <= text.length; i++) yield [text.slice(0, i), text.slice(i)];
}

function drain(filter, chunks) {
  return chunks.map(c => filter.push(c)).join('');
}

// The bytes a real shell would produce for one framed command: a login banner
// the command never wrote, the command's own output, then the frame.
function stdoutStream(nonce, { banner = '', body = '', code = 0, cwd = '/app' } = {}) {
  return `${banner}\n${beginFor(nonce)}\n${body}`
    + `\n${sentinelFor(nonce)} ${code} ${Buffer.from(cwd).toString('base64')}\n`;
}

function stderrStream(nonce, { banner = '', body = '' } = {}) {
  return `${banner}\n${beginFor(nonce)}\n${body}\n${sentinelFor(nonce)}\n`;
}

const BODIES = [
  '',                                   // a command that printed nothing
  'one line\n',                         // the ordinary case: a trailing newline
  'no trailing newline',                // and the case cc's injected \n exists for
  'a\nb\nc\n',
  'blank line follows\n\n',
  // A command that ECHOES the sentinel — the measured desync. Mid-line and at a
  // line start with a non-matching tail: both are OUTPUT, not a boundary.
  'echoing MARKER mid-line\nMARKER not-a-frame\ndone\n',
  // A line that starts like the sentinel but is a different marker.
  'MARKER_EXTRA 0 x\n',
];

// PINS THE WHOLE CONTRACT: for every body and every way of cutting the stream,
// what the filter emits equals what the parser extracts. One property, and it
// is the only thing the streaming path has to get right.
test('the stream filter emits exactly what the parser would extract, under every split', () => {
  const nonce = newNonce();
  const marker = sentinelFor(nonce);
  for (const raw of BODIES) {
    const body = raw.replaceAll('MARKER', marker);
    for (const banner of ['', 'nvm banner\n', 'unterminated banner']) {
      const text = stdoutStream(nonce, { banner, body });
      const expected = parseFramedStdout(text, nonce).text;
      for (const chunks of splittings(text)) {
        assert.equal(drain(new FramedStreamFilter(nonce, 'out'), chunks), expected,
          `stdout body=${JSON.stringify(body)} banner=${JSON.stringify(banner)}`);
      }
      const errText = stderrStream(nonce, { banner, body });
      const errExpected = parseFramedStderr(errText, nonce).text;
      for (const chunks of splittings(errText)) {
        assert.equal(drain(new FramedStreamFilter(nonce, 'err'), chunks), errExpected,
          `stderr body=${JSON.stringify(body)}`);
      }
    }
  }
});

// PINS: no fragment of a sentinel, or of the opening marker, ever reaches the
// worker — not even split across two chunks, which is the whole hazard
// streaming introduces. The login banner never reaches it either.
test('no part of the framing, and nothing before it, is ever emitted', () => {
  const nonce = newNonce();
  const text = stdoutStream(nonce, { banner: 'PROFILE BANNER\n', body: 'real output\n' });
  for (const chunks of splittings(text)) {
    const filter = new FramedStreamFilter(nonce, 'out');
    for (const c of chunks) {
      const emitted = filter.push(c);
      assert.ok(!emitted.includes('__CC_'), `leaked framing: ${JSON.stringify(emitted)}`);
      assert.ok(!emitted.includes('PROFILE'), `leaked the shell banner: ${JSON.stringify(emitted)}`);
    }
  }
});

// PINS: output really does come out EARLY. The property test above would be
// satisfied by a filter that emitted everything at the end, which is exactly
// the behaviour being replaced.
test('the filter emits a complete line before the frame closes', () => {
  const nonce = newNonce();
  const filter = new FramedStreamFilter(nonce, 'out');
  assert.equal(filter.push(`\n${beginFor(nonce)}\n`), '');
  assert.equal(filter.push('part1\n'), 'part1', 'the line is out; only cc\'s possible injected newline is held');
  assert.equal(filter.push('part2\n'), '\npart2');
  assert.equal(filter.push(`\n${sentinelFor(nonce)} 0 ${Buffer.from('/app').toString('base64')}\n`), '\n');
});

// PINS: when the frame NEVER closes — the command took the shell with it — what
// the command did print is still released, and still without any fragment of
// the framing. Held-back bytes are held pending a sentinel; once no sentinel can
// arrive, they are the command's own output and belong to the worker.
test('flushing an unclosed frame releases the output but never a partial sentinel', () => {
  const nonce = newNonce();
  const s = sentinelFor(nonce);

  const clean = new FramedStreamFilter(nonce, 'out');
  assert.equal(clean.push(`\n${beginFor(nonce)}\nO\nO2\n`), 'O\nO2');
  assert.equal(clean.flush(), '\n', 'the newline held pending a sentinel that never came');

  // The shell died PART WAY THROUGH writing the sentinel. Those bytes are
  // framing, not output, and must not be released by the flush.
  const cut = new FramedStreamFilter(nonce, 'out');
  cut.push(`\n${beginFor(nonce)}\nmine\n\n${s.slice(0, 12)}`);
  assert.ok(!cut.flush().includes('__CC_'), 'no fragment of the sentinel escapes');

  // And a flush is terminal, like the boundary.
  assert.equal(clean.flush(), '');
  assert.equal(clean.push('later'), '');
});

// PINS: once the frame has closed the filter goes quiet. A forgery's trailing
// output belongs to nobody, and letting it through would attribute it to the
// NEXT command — the desync the parser's first-match-wins rule exists to
// confine to one command.
test('the filter stops at the boundary and emits nothing after it', () => {
  const nonce = newNonce();
  const filter = new FramedStreamFilter(nonce, 'out');
  filter.push(stdoutStream(nonce, { body: 'mine\n' }));
  assert.equal(filter.push('output belonging to nobody\n'), '');
});

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
  // PINS: output reaches the caller BEFORE the command finishes, and what it
  // received is byte-identical to the buffered result. Asserted by ORDER, not
  // by wall clock — the first chunk must have arrived while `run()` was still
  // pending — so it is deterministic and cannot flake on a slow machine.
  //
  // Run in BOTH capability modes deliberately: a redirected Bash streams
  // whether or not the system carries a persistent shell, so the fallback is
  // not a version of the feature with the streaming quietly missing.
  test(`[${mode.name}] a command's output streams as it arrives, and matches the buffered result`, async () => {
    await withShell(mode.flags, async (sh) => {
      const seen = [];
      let settled = false;
      const run = sh.run(
        'printf "part1\\n"; printf "e1\\n" >&2; sleep 0.4; printf "part2\\n"; printf "e2\\n" >&2',
        {
          onOut: (t) => seen.push({ which: 'out', t, settled }),
          onErr: (t) => seen.push({ which: 'err', t, settled }),
        },
      );
      const r = await run;
      settled = true;

      const early = seen.filter(c => !c.settled);
      assert.ok(early.length > 0, 'something arrived while the command was still running');
      assert.match(early.map(c => c.t).join(''), /part1/, 'and it was the FIRST half, not the last');

      const streamed = (which) => seen.filter(c => c.which === which).map(c => c.t).join('');
      assert.equal(streamed('out'), r.stdout, 'the streamed stdout is byte-identical to the buffered one');
      assert.equal(streamed('err'), r.stderr, 'and so is stderr');
      assert.equal(r.stdout, 'part1\npart2\n');
      assert.equal(r.stderr, 'e1\ne2\n');
    });
  });

  // PINS: the two streams stay SEPARATE. Merging them would make a caller that
  // reads stderr for a diagnostic read the command's stdout instead — and the
  // buffered path has always kept them apart for free.
  test(`[${mode.name}] streamed stdout and stderr are never mixed`, async () => {
    await withShell(mode.flags, async (sh) => {
      const out = [];
      const err = [];
      await sh.run('printf "O\\n"; printf "E\\n" >&2; printf "O2\\n"',
        { onOut: (t) => out.push(t), onErr: (t) => err.push(t) });
      assert.equal(out.join(''), 'O\nO2\n');
      assert.equal(err.join(''), 'E\n');
    });
  });

  // PINS: nothing a streaming caller receives contains the framing or the login
  // shell's own banner — the property the filter exists for, asserted here
  // against a REAL shell rather than a synthesised stream.
  test(`[${mode.name}] a real shell's framing and banner never reach a streaming caller`, async () => {
    await withShell(mode.flags, async (sh) => {
      const chunks = [];
      const push = (t) => chunks.push(t);
      await sh.run('echo real-output', { onOut: push, onErr: push });
      for (const c of chunks) assert.ok(!c.includes('__CC_'), `leaked framing: ${JSON.stringify(c)}`);
      assert.equal(chunks.join(''), 'real-output\n');
    });
  });

  // PINS: a command that takes the shell with it still delivers what it printed
  // BEFORE it died. The buffered result cannot carry that output — there is no
  // frame to parse it out of — so the streamed path is the only way the worker
  // ever sees it, and dropping it would make the failure look emptier than it
  // was.
  test(`[${mode.name}] a command that kills the shell still streams what it printed`, async () => {
    await withShell(mode.flags, async (sh) => {
      const out = [];
      await assert.rejects(
        sh.run('printf "printed-before-dying\\n"; exit 3', { onOut: (t) => out.push(t) }),
        (e) => { assert.equal(e.code, 'ESHELLGONE'); return true; },
      );
      assert.equal(out.join(''), 'printed-before-dying\n');
      for (const c of out) assert.ok(!c.includes('__CC_'), 'and no framing came with it');
    });
  });

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

  // PINS: cc serialises per shell, and the wait a queued call is willing to
  // spend is ITS OWN timeout — a call that would only run for 30ms gives up
  // waiting after 30ms, with EBUSY.
  test(`[${mode.name}] cc serialises per shell, and a wait past the call's own timeout is EBUSY`, async () => {
    await withShell(mode.flags, async (sh) => {
      const slow = sh.run('sleep 0.5; echo slow');
      await assert.rejects(() => sh.run('echo fast', { timeoutMs: 30 }), (e) => {
        assert.equal(e.code, 'EBUSY', `got ${e.code}: ${e.message}`);
        return true;
      });
      assert.equal((await slow).stdout, 'slow\n', 'the command that held the shell still completes');
    });
  });

  // PINS B3: a command that produces more output than the fence allows is
  // KILLED and reported as a failure. Without a fence cc accumulates every byte
  // the command produces in its own heap, so one runaway command on one session
  // takes the orchestrator — and every other session on it — down with it. A
  // reported failure is the whole point: a truncated success would be read as
  // the command's real output.
  test(`[${mode.name}] a command past the output fence is killed and reported, not accumulated`, async () => {
    await withShell(mode.flags, async (sh) => {
      const streamed = [];
      await assert.rejects(
        () => sh.run('head -c 200000 /dev/zero | base64', { onOut: (t) => streamed.push(t) }),
        (e) => {
          assert.equal(e.code, 'EFBIG', `got ${e.code}: ${e.message}`);
          assert.match(e.message, /8192/, 'the failure names the limit it hit');
          return true;
        },
      );
      // Bounded, not merely "less than everything": nothing past the fence is
      // streamed either, so a live consumer cannot see output cc did not keep.
      assert.ok(streamed.join('').length <= 8192 * 2,
        `streamed ${streamed.join('').length} bytes past an 8192-byte fence`);
      // And the shell recovers.
      assert.equal((await sh.run('echo alive')).stdout, 'alive\n');
    }, { maxOutputBytes: 8192 });
  });

  // PINS C4: the fence counts BYTES in both modes. The persistent path counted
  // UTF-16 units, so multibyte output rode up to ~2-4x past the limit the fence
  // exists to hold — while the fallback counted bytes, making the two modes
  // disagree about the one number that keeps cc's heap bounded.
  test(`[${mode.name}] the fence counts bytes, not characters`, async () => {
    await withShell(mode.flags, async (sh) => {
      const streamed = [];
      // 3 bytes per character in UTF-8, one UTF-16 unit each: a
      // character-counting fence admits three times the bytes it promises.
      await assert.rejects(
        () => sh.run('for i in $(seq 1 4000); do printf "\u4e2d\u6587\u5b57"; done', { onOut: (t) => streamed.push(t) }),
        (e) => { assert.equal(e.code, 'EFBIG', `got ${e.code}: ${e.message}`); return true; },
      );
      assert.ok(Buffer.byteLength(streamed.join(''), 'utf8') <= 8192 * 2,
        `streamed ${Buffer.byteLength(streamed.join(''), 'utf8')} bytes past an 8192-BYTE fence`);
    }, { maxOutputBytes: 8192 });
  });

  // PINS: the fence does not clip an ordinary command. A fence that fired early
  // would turn every normal result into a failure.
  test(`[${mode.name}] output below the fence is untouched`, async () => {
    await withShell(mode.flags, async (sh) => {
      const r = await sh.run('head -c 4000 /dev/zero | tr "\\0" "x"');
      assert.equal(r.stdout.length, 4000);
      assert.equal(r.code, 0);
    }, { maxOutputBytes: 8192 });
  });

  // ── Cancellation ───────────────────────────────────────────────────

  // PINS: cancelling a QUEUED call cancels that call and NOTHING ELSE. The
  // in-flight command finishes normally, and — the part that matters — the
  // cancelled command never runs, so its effects never land on the system. An
  // interrupt whose command executes anyway defeats the point of interrupting.
  test(`[${mode.name}] cancelling a queued command runs neither it nor over the one in flight`, async () => {
    await withShell(mode.flags, async (sh, cwd) => {
      const witness = path.join(cwd, 'QUEUED_RAN');
      const inFlight = sh.run('sleep 0.4; echo survivor');
      const ac = new AbortController();
      const queued = sh.run(`touch ${JSON.stringify(witness)}`, { signal: ac.signal });
      // Abort while it is still waiting for its turn.
      ac.abort();

      await assert.rejects(() => queued, (e) => {
        assert.equal(e.code, 'ECANCELLED', `got ${e.code}: ${e.message}`);
        return true;
      });
      const r = await inFlight;
      assert.equal(r.stdout, 'survivor\n', 'the unrelated in-flight command was untouched');
      assert.equal(r.code, 0);
      await assert.rejects(fs.stat(witness), 'the cancelled command never ran');
    });
  });

  // PINS: cancelling the IN-FLIGHT call stops the command itself — including in
  // the fallback mode, where there is no live stream to close and cc has to
  // reach the far side through `exec`'s own cancellation. Asserted by the
  // command's own witness file, written after a delay: a command still running
  // when the assertion is made will have written it.
  test(`[${mode.name}] cancelling the in-flight command actually stops it`, async () => {
    await withShell(mode.flags, async (sh, cwd) => {
      const witness = path.join(cwd, 'STILL_RUNNING');
      const ac = new AbortController();
      const running = sh.run(`sleep 0.4; touch ${JSON.stringify(witness)}`, { signal: ac.signal });
      // Let it start, then interrupt it well before its own sleep elapses.
      await new Promise(r => setTimeout(r, 120));
      ac.abort();
      await assert.rejects(() => running, (e) => {
        assert.equal(e.code, 'ECANCELLED', `got ${e.code}: ${e.message}`);
        return true;
      });
      // Past when the command would have written it, had it survived.
      await new Promise(r => setTimeout(r, 500));
      await assert.rejects(fs.stat(witness), 'the interrupted command is not still running on the system');
    });
  });

  // PINS: a signal that is already aborted never starts the command at all.
  test(`[${mode.name}] a pre-aborted signal never reaches the system`, async () => {
    await withShell(mode.flags, async (sh, cwd) => {
      const witness = path.join(cwd, 'PRE_ABORTED');
      await assert.rejects(
        () => sh.run(`touch ${JSON.stringify(witness)}`, { signal: AbortSignal.abort() }),
        (e) => { assert.equal(e.code, 'ECANCELLED'); return true; },
      );
      await assert.rejects(fs.stat(witness));
    });
  });

  // PINS S2: the queue wait is the CALL'S OWN timeout, not a fixed bound. A
  // long command must not make a queued call that was willing to wait for it
  // fail with "the shell is busy" while everything is healthy.
  test(`[${mode.name}] a queued call waits as long as its own timeout allows`, async () => {
    await withShell(mode.flags, async (sh) => {
      const slow = sh.run('sleep 0.4; echo first');
      // Past the 30ms default bound, inside its own 10s one.
      const queued = await sh.run('echo second', { timeoutMs: 10_000 });
      assert.equal(queued.stdout, 'second\n', 'it waited for its turn instead of failing EBUSY');
      assert.equal((await slow).stdout, 'first\n');
    });
  });

  // PINS S1: the reset reason is delivered to the command that RUNS on the new
  // shell, not to whichever call happened to be constructed next. R5's rule is
  // that a reconnected shell SAYS it lost state — a notice attached to the
  // wrong command means the command that actually ran on the fresh shell said
  // nothing.
  test(`[${mode.name}] the reset reason goes to the next command to acquire the shell`, async () => {
    await withShell(mode.flags, async (sh) => {
      assert.equal(sh.takeResetReason(), null, 'a healthy shell has nothing to report');
      await assert.rejects(() => sh.run('exit 3'));

      const seen = [];
      await sh.run('echo after', { onStart: () => seen.push(sh.takeResetReason()) });
      assert.equal(seen.length, 1);
      assert.match(seen[0] ?? '', /shell|exit/i, 'the command that ran on the fresh shell was told why');
      // And exactly once: the next command has nothing to report.
      const again = [];
      await sh.run('echo later', { onStart: () => again.push(sh.takeResetReason()) });
      assert.deepEqual(again, [null]);
    });
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

// PINS C2: an abort that lands while the shell is being OPENED still cancels
// the command. `run()` checks the signal before acquiring and again after, then
// awaits `#ensureStream()` — and the kill listener only arms inside `#exchange`,
// after that await. An abort in that gap was seen by neither, and the listener
// then armed `{once:true}` on an already-fired signal, so the command was
// written to the shell and could NEVER be stopped: a second abort could not save
// it. The window opens on every FIRST command and on every reopen after a
// wedge, deadline, idle sweep, abort or output-fence reset.
//
// Driven through a fake host whose openStream is deliberately slow, because the
// window is an I/O race that cannot be hit over HTTP on demand.
test('an abort while the shell is opening cancels the command, and it never reaches the shell', async () => {
  let releaseOpen;
  const opening = new Promise((r) => { releaseOpen = r; });
  const { host, state } = fakeHost({ respond: () => ({ stdout: 'ran' }) });
  const inner = host.openStream.bind(host);
  host.openStream = async (spec, opts, handlers) => {
    // Hand control back to the test with the open still in flight, which is
    // exactly where the gap is.
    const stream = await inner(spec, opts, handlers);
    await opening;
    return stream;
  };

  const sh = new ProviderShell(host, { cwd: '/w', commandTimeoutMs: 2000 });
  const ac = new AbortController();
  const started = [];
  const call = sh.run('touch WITNESS', { signal: ac.signal, onStart: () => started.push(1) });
  // The call is past both checks and inside the open: onStart has fired.
  await waitFor(() => started.length === 1, { timeout: 2000 });
  ac.abort();
  releaseOpen();

  await assert.rejects(() => call, (e) => {
    assert.equal(e.code, 'ECANCELLED', `got ${e.code}: ${e.message}`);
    return true;
  });
  assert.deepEqual(state.commands, [], 'the cancelled command was never written to the shell');

  // And the shell is still usable afterwards — the gap check must not wedge it.
  const after = await sh.run('echo alive');
  assert.equal(after.stdout, 'ran');
  assert.equal(state.commands.length, 1, 'exactly one command reached the shell');
});

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
