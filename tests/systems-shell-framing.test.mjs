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
// ONE `exec` PER COMMAND is the whole contract (card 2026-0312): nothing
// outlives a command, so nothing carries between two.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_COMMAND_TIMEOUT_MS, ProviderShell } from '../src/systems/providerShell.ts';
import {
  FramedStreamFilter, beginFor, frameCommand, newNonce,
  parseFramedStderr, parseFramedStdout, sentinelFor,
} from '../src/systems/shellFraming.ts';
import { CAPABILITY_CONFIGS, makeProviderSystem } from './referenceProviderHarness.mjs';
import { rmrf } from './rmrf.mjs';
import { waitFor } from './helpers.mjs';

// The opening sentinel exactly as the framed script emits it — INCLUDING the
// injected leading newline, without which the marker glues itself to whatever
// the shell printed before it. Everything before it belongs to the shell, so a
// parser test that omits it is testing a stream that could never occur.
const B = (n) => `\n${beginFor(n)}\n`;

async function withShell(fn, shellOpts = {}, flags = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-shell-'));
  const cwd = await fs.realpath(dir);
  const sys = makeProviderSystem(flags);
  try {
    await sys.connect();
    return await fn(sys.shell({ cwd, ...shellOpts }), cwd, sys);
  } finally {
    sys.dispose();
    await rmrf(dir);
  }
}

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

test('the nonce is fresh per command, and the script keeps cd and export in the shell FOR THAT COMMAND', () => {
  // THE RANDOMNESS IS WHAT THIS PINS, and it is the whole of what the nonce is
  // relied on for post-card-2026-0312: a CONSTANT nonce is forgeable, which is
  // the measured desync. The per-command FRESHNESS this expression also happens
  // to demonstrate is NOT load-bearing — each command has its own `exec`, stream
  // and parser, so a forgery cannot leave the command that made it — and it is
  // deliberately not pinned at the call site. What is load-bearing there is the
  // PAIRING (framed with the nonce it is parsed with), which the concurrency
  // tests catch.
  assert.notEqual(newNonce(), newNonce(), 'a CONSTANT nonce is forgeable — that is the measured desync');
  assert.match(newNonce(), /^[0-9a-f]{32}$/, '128 bits');
  const script = frameCommand('N', 'echo hi');
  assert.ok(script.startsWith(String.raw`printf '\n__CC_N_BEGIN__\n'; printf '\n__CC_N_BEGIN__\n' >&2`),
    'the opening sentinel is emitted on BOTH streams before the command runs, each newline-prefixed');
  assert.match(script, /\{ echo hi\n\} < \/dev\/null\n/, 'braces, not a subshell, so cd and export land in the shell running THIS command — nothing carries to the next one, which has its own');
  assert.match(script, /< \/dev\/null/, 'the command group gets a closed stdin, like project_bash and the Bash tool');
  assert.ok(script.includes(String.raw`printf '\n__CC_N__\n' >&2`),
    'stderr carries its own sentinel, newline-prefixed like stdout\'s, so a command whose stderr has no trailing newline still frames');
});

// ── End to end, against a real provider ─────────────────────────────

// PINS: output reaches the caller BEFORE the command finishes, and what it
// received is byte-identical to the buffered result. Asserted by ORDER, not
// by wall clock — the first chunk must have arrived while `run()` was still
// pending — so it is deterministic and cannot flake on a slow machine.
//
// Streaming is ORTHOGONAL to the framing and must stay that way: it rides
// `exec`'s own `onChunk` hook through the same filters the buffered result is
// parsed with, so the live and buffered views cannot disagree.
test(`a command's output streams as it arrives, and matches the buffered result`, async () => {
  await withShell(async (sh) => {
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
test(`streamed stdout and stderr are never mixed`, async () => {
  await withShell(async (sh) => {
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
test(`a real shell's framing and banner never reach a streaming caller`, async () => {
  await withShell(async (sh) => {
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
test(`a command that kills the shell still streams what it printed`, async () => {
  await withShell(async (sh) => {
    const out = [];
    await assert.rejects(
      sh.run('printf "printed-before-dying\\n"; exit 3', { onOut: (t) => out.push(t) }),
      (e) => { assert.equal(e.code, 'ESHELLGONE'); return true; },
    );
    assert.equal(out.join(''), 'printed-before-dying\n');
    for (const c of out) assert.ok(!c.includes('__CC_'), 'and no framing came with it');
  });
});

// T6 — INVERTED on card 2026-0312, and this is the parity the whole card exists
// for: a `cd` does NOT reach the next command. It used to, in BOTH capability
// modes — the one-shot fallback carried the sentinel's `$PWD` into the next
// `exec`'s `cwd`, so this test passed for the wrong reason and the card's claim
// that "the code path already exists" was false for cwd (card 2026-0312 §1 C-1).
// Locally the CLI gives every Bash call a fresh shell AND announces the reset.
//
// CAPTURE SURVIVED, CARRY DIED, and both halves are asserted: the result still
// REPORTS where the command ended — read back from the shell's own `$PWD`, so an
// indirect `cd` is tracked just as well — and the NEXT command still starts
// where the shell was configured. A change that restored the carry fails the
// second half; one that dropped the capture fails the first, and would take the
// worker's cwd notice with it (src/systems/toolRedirect.ts).
test(`a cd is CAPTURED but never carried — the next command starts where the shell was configured`, async () => {
  await withShell(async (sh, cwd) => {
    const a = await sh.run('cd /tmp; echo one');
    assert.equal(a.stdout, 'one\n');
    assert.equal(a.cwd, '/tmp', 'the result reports where the command ENDED');

    const b = await sh.run('pwd');
    assert.equal(b.stdout.trim(), cwd, 'and the SECOND command started where the shell was configured');
    assert.equal(b.cwd, cwd);

    // Not parsed out of the command text: the cwd comes back from the shell's
    // own $PWD, so an indirect cd is tracked just as well.
    const c = await sh.run('d=/tmp; cd "$d"');
    assert.equal(c.cwd, '/tmp');
    assert.equal((await sh.run('pwd')).stdout.trim(), cwd, 'and that one did not carry either');
  });
});

// INVERTED on card 2026-0312: this used to assert that a long-lived shell
// CARRIED exports and that only the fallback did not. There is no long-lived
// shell any more, so nothing a command exports reaches its next one — which is
// what the local CLI already does, where each Bash call gets a brand-new shell.
//
// THREE SHAPES, not one: an exported variable, a plain one, and a shell
// function. An implementation that carried only some of them would pass a
// single-shape test.
//
// NOT CLAIMING anything about cwd, which has its own test.
test(`nothing a command exports reaches the next one`, async () => {
  await withShell(async (sh) => {
    await sh.run('export CC_EXPORTED=x; CC_PLAIN=y; cc_fn() { echo z; }');
    const r = await sh.run('echo "[$CC_EXPORTED][$CC_PLAIN]"; type cc_fn >/dev/null 2>&1 && echo FN || echo NO-FN');
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[0], '[][]', 'neither an exported nor a plain variable survives its own command');
    assert.equal(lines[1], 'NO-FN', 'and neither does a shell function');
  });
});

test(`exit codes are captured, and stderr is routed with its own sentinel`, async () => {
  await withShell(async (sh) => {
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
    const bare = await sh.run('printf out-no-nl; printf err-no-nl >&2');
    assert.equal(bare.stdout, 'out-no-nl');
    assert.equal(bare.stderr, 'err-no-nl');
    assert.equal(bare.code, 0);
  });
});

test(`a STALE sentinel echoed by a later command does not desync the stream`, async () => {
  await withShell(async (sh) => {
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

test(`a command that exits the shell surfaces ESHELLGONE, and the next one works`, async () => {
  await withShell(async (sh) => {
    await assert.rejects(() => sh.run('exit 7'), (e) => {
      assert.equal(e.code, 'ESHELLGONE', `expected ESHELLGONE, got ${e.code}: ${e.message}`);
      return true;
    });
    const after = await sh.run('echo recovered');
    assert.equal(after.stdout, 'recovered\n', 'the shell is re-established on the next command');
  });
});

// INVERTED on card 2026-0312: THE WEDGE CLASS IS GONE. A live shell handed an
// unterminated quote sat reading a continuation line that would never come, so
// the command hung until the per-command deadline fired — the ceiling's second
// job. With one shell per command the same script never parses, bash dies before
// the framing runs, and the failure is ESHELLGONE arriving IMMEDIATELY: measured
// 17ms against the full 1504ms deadline in the mode this replaces.
//
// The deadline is deliberately generous here (4s) so that a run inside it proves
// the ceiling was NOT what settled this — under the old 400ms a wedge and a fast
// failure are indistinguishable at this resolution.
//
// NOT CLAIMING a bound in milliseconds — that is a wall clock. What is asserted
// is that it settled well inside a ceiling it never reached.
test(`an unterminated quote fails immediately — the wedge class is gone`, async () => {
  await withShell(async (sh) => {
    const started = Date.now();
    await assert.rejects(() => sh.run("echo 'unterminated"), (e) => {
      assert.equal(e.code, 'ESHELLGONE', `got ${e.code}: ${e.message}`);
      return true;
    });
    assert.ok(Date.now() - started < 4_000,
      'it failed on its own, well inside a ceiling it never reached');
    const after = await sh.run('echo alive');
    assert.equal(after.stdout, 'alive\n', 'and it cost the next command nothing');
  }, { commandTimeoutMs: 4_000 });
});

test(`a shell that cannot START says why — ENOENT, not "the shell died"`, async () => {
  await withShell(async (sh, cwd) => {
    assert.equal((await sh.run('echo before')).stdout, 'before\n');
    // The cwd goes away under the shell. Every command opens its own, so the
    // next one hits this immediately.
    await rmrf(cwd);
    await assert.rejects(() => sh.run('echo after'), (e) => {
      assert.equal(e.code, 'ENOENT', `expected ENOENT, got ${e.code}: ${e.message}`);
      return true;
    });
  });
});

// PINS D4's WORDING at the one message site left: `#runOneShot`'s `r.timedOut`
// branch, where the PROVIDER killed the command because cc handed it the
// deadline on the `exec` frame. It has to name the ceiling AS a ceiling rather
// than describe a wedge, because a worker at the ceiling now reads it for a
// command that legitimately ran that long (card 2026-0305 §4 D4). Its only other
// killer is tests/systems-shell-ceiling-env.test.mjs reading the number back out
// of the message, which is INCIDENTAL — that test would still pass with the old
// wedge-shaped wording restored.
//
// 400ms against a 30s sleep — a 60x+ margin. Measured n=16: 401-404ms quiet,
// 401-438ms at 72-way starvation (load 40).
//
// NO RECOVERY ASSERTION HERE, DELIBERATELY — do not add one back. A
// `run('echo alive')` after it would run under this same 400ms ceiling, which is
// the one thin margin on this card (measured 3.0x at 72-way, max 132ms), and it
// would buy nothing: there is nothing to recover, since each command is its own
// `exec` and this branch tears nothing down.
test(`the ceiling names itself as a ceiling in the message a worker reads`, async () => {
  await withShell(async (sh) => {
    await assert.rejects(() => sh.run('sleep 30'), (e) => {
      assert.equal(e.code, 'ETIMEDOUT', `got ${e.code}: ${e.message}`);
      // The number is THIS shell's resolved ceiling, so a literal fails here;
      // and the phrasing is the ceiling's, not the wedge's.
      assert.match(e.message, /still running after 400ms/, e.message);
      assert.match(e.message, /per-command ceiling/, e.message);
      return true;
    });
  }, { commandTimeoutMs: 400 });
});

// PINS B3: a command that produces more output than the fence allows is
// KILLED and reported as a failure. Without a fence cc accumulates every byte
// the command produces in its own heap, so one runaway command on one session
// takes the orchestrator — and every other session on it — down with it. A
// reported failure is the whole point: a truncated success would be read as
// the command's real output.
test(`a command past the output fence is killed and reported, not accumulated`, async () => {
  await withShell(async (sh) => {
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

// PINS C4: the fence counts BYTES, not UTF-16 units. Counting units let
// multibyte output ride up to ~2-4x past the limit the fence exists to hold.
test(`the fence counts bytes, not characters`, async () => {
  await withShell(async (sh) => {
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
test(`output below the fence is untouched`, async () => {
  await withShell(async (sh) => {
    const r = await sh.run('head -c 4000 /dev/zero | tr "\\0" "x"');
    assert.equal(r.stdout.length, 4000);
    assert.equal(r.code, 0);
  }, { maxOutputBytes: 8192 });
});

// ── A backgrounded job does not hold the command open ────────────────
//
// MEASURED (card 2026-0318 §1): the reference provider emits its `exit` frame
// from the child's `'close'`, which fires when the STREAMS close, not when the
// process exits. A `cmd &` job inherits the command's stdout pipe and holds it
// open for as long as it runs — so a command that exited 0 was reported to the
// worker as a FAILURE with an EMPTY stdout, at cc's own abandon timer
// (`timeoutMs + EXEC_TIMEOUT_SLACK_MS`), while the complete parsed answer had
// been on the wire since ~154 ms.
//
// cc does not wait for `exit` on a redirected command any more: its OWN closing
// sentinel, on both streams, is the exact end-of-output marker, and it needs no
// heuristic and no grace timer to know it.

for (const config of CAPABILITY_CONFIGS) {
  const tag = `[${config.name}]`;

  // THE POSITIVE CONTROL, in the same file, the same fixture and the same
  // ceiling as the row below it: a harness that framed or ran nothing would
  // fail HERE, so the row below cannot pass by not running.
  test(`${tag} a plain command still settles on its sentinel with its own exit code`, async () => {
    await withShell(async (sh) => {
      // `(exit 3)` and not a bare `exit 3`: the framing runs the command inside
      // braces, so a bare exit takes the shell with it (ESHELLGONE) and this
      // would stop being a control for the row below.
      const r = await sh.run('echo hi; echo boom >&2; (exit 3)');
      assert.equal(r.stdout, 'hi\n');
      assert.equal(r.stderr, 'boom\n');
      assert.equal(r.code, 3, "the sentinel's code is the command's, not the settle's");
    }, { commandTimeoutMs: 1_000 }, config.flags);
  });

  // PINS THE HEADLINE of card 2026-0318: a command that backgrounds a job and
  // exits 0 is reported as exit 0 with the output it printed. Asserted on the
  // CODE and the STDOUT, not on latency — the defect was never slowness, it was
  // a succeeded command reported as a failure with its output dropped.
  test(`${tag} a command that backgrounds a job reports its own exit code and output`, async () => {
    await withShell(async (sh, cwd) => {
      const pidFile = path.join(cwd, 'bg.pid');
      let pid = 0;
      try {
        const r = await sh.run(`sleep 60 & echo $! > ${pidFile}; echo started`);
        assert.equal(r.code, 0, 'the command exited 0 and is reported as exit 0');
        assert.equal(r.stdout, 'started\n', 'and its stdout is what it printed, not empty');
        assert.equal(r.stderr, '');
        pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      } finally {
        if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
    }, { commandTimeoutMs: 1_000 }, config.flags);
  });
}

// ── The settle scan agrees with the parser, or it must not settle ────
//
// `completeMarker` settles an `exec` the moment the marker has been seen on both
// streams (card 2026-0318 §5.2). A settle the PARSER then rejects is the worst
// available outcome: `#runOneShot` throws `ESHELLGONE` on a command that
// succeeded — the exact defect class this card exists to remove, reintroduced at
// the seam that removed it. So the scan has to validate everything the parser
// validates, the per-stream TAIL included: `<marker> <rc> <b64cwd>` on stdout,
// and nothing at all after the marker on stderr.
//
// Driven through `execOneShot` with a marker of the test's own choosing rather
// than through `run()`: the nonce a real command would have to forge is
// unguessable by construction, so this is the only way to put a rejectable
// candidate on the wire at all.
//
// THE DISCRIMINATOR IS THE EXIT CODE, and it is exact, not a race: a
// marker-settle resolves `code: 0` unconditionally, while waiting for the `exit`
// frame resolves the command's own code. The provider writes both stream frames
// before the exit frame (the child's `'close'` fires after its last `'data'`),
// so which one settled the call is readable off `code` alone.
const REJECTABLE_TAILS = [
  { name: 'stdout tail that is not `<rc> <cwd>`', out: ' not-a-frame', err: '' },
  { name: 'stdout tail missing the cwd field', out: ' 0', err: '' },
  { name: 'stderr tail that is not empty', out: ' 0 Lw==', err: ' 0 Lw==' },
];

for (const c of REJECTABLE_TAILS) {
  test(`a settle candidate the parser would REJECT does not settle the exec (${c.name})`, async () => {
    await withShell(async (_sh, cwd, sys) => {
      const m = `__CC_${'ab12cd34'.repeat(4)}__`;
      const r = await sys.execOneShot(
        { shell: `printf '\n${m}${c.out}\n'; printf '\n${m}${c.err}\n' >&2; exit 7` },
        { cwd, timeoutMs: 4_000, completeMarker: m },
      );
      assert.equal(r.code, 7,
        'the exec waited for the real exit frame — a scan-settle would have reported 0 '
        + 'and left the parser to throw ESHELLGONE on a command that succeeded');
    });
  });
}

// THE POSITIVE CONTROL for the three rows above: the SAME shape with tails the
// parser accepts DOES settle on the marker, before the exit frame. Without it,
// a scan that never settled at all would pass all three.
test('a settle candidate the parser ACCEPTS settles the exec, ahead of the exit frame', async () => {
  await withShell(async (_sh, cwd, sys) => {
    const m = `__CC_${'ab12cd34'.repeat(4)}__`;
    const r = await sys.execOneShot(
      { shell: `printf '\n${m} 0 ${Buffer.from(cwd).toString('base64')}\n'; printf '\n${m}\n' >&2; exit 7` },
      { cwd, timeoutMs: 4_000, completeMarker: m },
    );
    assert.equal(r.code, 0, 'the marker settled it, and `code` is the settle\'s rather than the command\'s');
    assert.ok(r.stdout.includes(m), 'and the frame it settled on really is in the output it settled from');
  });
});

// A FORGERY DOES NOT CONSUME THE BOUNDARY. The parser keeps scanning past a
// sentinel line whose tail does not match (`shellFraming.ts`, FIRST MATCH WINS
// applies to the first VALID one), so the scan must too — stopping at the
// forgery would leave a real frame arriving afterwards unseen for ever.
test('a rejected candidate does not blind the scan to the real frame behind it', async () => {
  await withShell(async (_sh, cwd, sys) => {
    const m = `__CC_${'ab12cd34'.repeat(4)}__`;
    const r = await sys.execOneShot(
      {
        shell: `printf '\n${m} not-a-frame\n'; printf '\n${m} 0 ${Buffer.from(cwd).toString('base64')}\n'; `
          + `printf '\n${m} also-not\n' >&2; printf '\n${m}\n' >&2; exit 7`,
      },
      { cwd, timeoutMs: 4_000, completeMarker: m },
    );
    assert.equal(r.code, 0, 'the VALID frame behind the forgery still settled the exec');
  });
});

// ── Cancellation ───────────────────────────────────────────────────

// PINS: cancelling a command stops the command itself. There is no live stream
// to close, so the abort has to reach the far side through `exec`'s own
// cancellation. Asserted by the command's own witness file, written after a
// delay: a command still running when the assertion is made will have written it.
test(`cancelling the in-flight command actually stops it`, async () => {
  await withShell(async (sh, cwd) => {
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

// T4 — PINS THAT NOTHING SERIALISES, and that EBUSY cannot come back. Two
// commands issued on ONE shell at the same instant both run: distinct far-side
// pids, both exit 0, neither refused.
//
// STRUCTURAL, not wall-clock: neither command can finish unless the other was
// already running, because they rendezvous through two files. Under the turn
// this replaces, the second waited for the first to release the shell and both
// failed on their bound — this test cannot pass with a queue in the middle.
//
// NOT CLAIMING any ordering between them, only simultaneous progress.
test(`two commands on one shell run at the same time — nothing takes a turn`, async () => {
  await withShell(async (sh, cwd) => {
    const [a, b] = await Promise.all([
      sh.run(`cd ${JSON.stringify(cwd)}; touch A_UP; while [ ! -e B_UP ]; do sleep 0.02; done; echo "A $$"`),
      sh.run(`cd ${JSON.stringify(cwd)}; touch B_UP; while [ ! -e A_UP ]; do sleep 0.02; done; echo "B $$"`),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const [aTag, aPid] = a.stdout.trim().split(' ');
    const [bTag, bPid] = b.stdout.trim().split(' ');
    assert.deepEqual([aTag, bTag], ['A', 'B'], 'each result holds only its own output');
    assert.notEqual(aPid, bPid, 'two independent far-side processes, not one shell taking turns');
  }, { commandTimeoutMs: 8_000 });
});

// PINS THE CONTRACT A CALLER GETS for a signal that is already aborted:
// `ECANCELLED`, and the command's write does not land. It does NOT pin the
// pre-crossing check — measured, this case passes with that check deleted,
// because the re-check after `exec` throws the same error and the far side's own
// spawn was killed before the `touch` ran (card 2026-0328 §2). The host-seam
// case below is what pins the crossing.
test(`a pre-aborted signal fails ECANCELLED and its write does not land`, async () => {
  await withShell(async (sh, cwd) => {
    const witness = path.join(cwd, 'PRE_ABORTED');
    await assert.rejects(
      () => sh.run(`touch ${JSON.stringify(witness)}`, { signal: AbortSignal.abort() }),
      (e) => { assert.equal(e.code, 'ECANCELLED'); return true; },
    );
    await assert.rejects(fs.stat(witness));
  });
});

// PINS THAT A PRE-ABORTED COMMAND IS NOT PASSED TO `execOneShot` — the half the
// end-to-end case above cannot see, because the RESULT is `ECANCELLED` either
// way: the re-check after `exec` returns throws the same error. The host seam is
// what makes the difference observable. Measured with the pre-crossing check
// deleted: the framed command went out and the reference provider spawned it in
// 200 of 200 runs, killed by the `close` frame before the `touch` ran
// (card 2026-0328 §2).
test(`a pre-aborted command is not passed to execOneShot`, async () => {
  const { host, state } = fakeHost({ respond: () => ({ stdout: 'ran\n' }) });
  await assert.rejects(
    () => new ProviderShell(host, { cwd: '/w' }).run('touch W', { signal: AbortSignal.abort() }),
    (e) => { assert.equal(e.code, 'ECANCELLED'); return true; },
  );
  assert.deepEqual(state.commands, [], 'the host was handed no command');
});

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

// A one-shot ShellHost that answers a framed `exec` exactly as a real shell
// running that script would, WITHOUT a provider process — so the two cases below
// do not depend on which login shell the box happens to have.
//
// `respond` returns `{stdout, stderr, code, cwd}` for the command it is handed,
// or `{silent: true}` for a command whose sentinel NEVER ARRIVES. A silent
// command is held until either the deadline cc gave the `exec` elapses (answered
// `timedOut`, exactly as a provider that killed it does) or the test releases it.
function fakeHost({ banner = '', bannerErr = '', respond }) {
  const state = { commands: [], held: [], releaseHeld: null };
  const host = {
    async execOneShot(spec, opts) {
      const script = spec.shell;
      const nonce = /__CC_([0-9a-f]+)_BEGIN__/.exec(script)[1];
      const command = /\{ ([\s\S]*?)\n\} < \/dev\/null\n/.exec(script)[1];
      state.commands.push(command);
      const r = respond(command, nonce) ?? {};
      // Byte-for-byte what a shell running this script would produce: the login
      // banner, the opening sentinel, the command's output, then the closing
      // sentinel — with the stdout one's `%d %s` filled in as the shell fills
      // them. A NEW shell per command, so the banner is on every one.
      const { out, err } = shellEmissions(script);
      const closingOut = out[1]
        .replace('%d', String(r.code ?? 0))
        .replace('%s', Buffer.from(r.cwd ?? '/w').toString('base64'));
      const done = (stdout, stderr, extra = {}) => ({
        code: 0, stdout, stderr, output: stdout + stderr,
        timedOut: false, truncated: false, durationMs: 0, spawnError: null, ...extra,
      });
      if (r.silent) {
        return new Promise((resolve) => {
          // Whatever the shell managed before it went quiet: the banner and the
          // opening sentinel, and no boundary.
          const partial = () => resolve(done(`${banner}${out[0]}`, `${bannerErr}${err[0]}`));
          state.held.push(partial);
          state.releaseHeld = () => { for (const h of state.held.splice(0)) h(); };
          if (opts.timeoutMs !== undefined) {
            setTimeout(() => resolve(done('', '', { timedOut: true })), opts.timeoutMs).unref?.();
          }
        });
      }
      return done(
        `${banner}${out[0]}${r.stdout ?? ''}${closingOut}`,
        `${bannerErr}${err[0]}${r.stderr ?? ''}${err[1]}`,
      );
    },
  };
  return { host, state };
}

// A host that records the `timeoutMs` each command's `exec` was actually given,
// and answers it as a real shell running the framed script would. The resolved
// deadline is VISIBLE there — it leaves cc as `ExecOptions.timeoutMs` — which is
// why the probe reads it off the frame rather than off a cc-side timer.
function recordingOneShotHost() {
  const seen = [];
  const host = {
    async execOneShot(spec, opts) {
      seen.push(opts.timeoutMs);
      const { out, err } = shellEmissions(spec.shell);
      const closing = out[1].replace('%d', '0').replace('%s', Buffer.from('/w').toString('base64'));
      const stdout = `${out[0]}${closing}`;
      const stderr = `${err[0]}${err[1]}`;
      return {
        code: 0, stdout, stderr, output: stdout + stderr,
        timedOut: false, truncated: false, durationMs: 0, spawnError: null,
      };
    },
  };
  return { host, seen };
}

// PINS card 2026-0305 §4 D1 AND D2, and the fact that no caller has a run bound
// to offer any more: EVERY command's `exec` carries cc's ceiling as its
// `timeoutMs`, and nothing on the call can move it.
//
// THE UNKNOWN-OPTION HALF IS THE GUARD THAT SURVIVED THE DELETION. `run()` takes
// an options object, so a future editor re-introducing a caller-supplied run
// bound would do it by reading a key back off it — and a test that only called
// `run(cmd)` would pass throughout. Passing `timeoutMs` explicitly and asserting
// the ceiling is unmoved is what fails that.
//
// The value itself is pinned here too, because it is derived rather than
// written: 600_000 is the built-in Bash tool's documented max (the same number
// src/mcp/handlers.ts clamps `project_bash` to) plus 5s of slack, so that for a
// tool timeout up to that documented max the caller's own timer is the one that
// decides the outcome and never cc's. Past the documented max that ordering is
// unmeasured and ORCH_SHELL_COMMAND_TIMEOUT_MS is what restores it — this test
// pins the NUMBER and the derivation, and claims nothing about which timer wins.
test("the per-command deadline is cc's ceiling, and no caller can move it", async () => {
  assert.equal(DEFAULT_COMMAND_TIMEOUT_MS, 605_000, 'the ceiling is 600_000 + 5_000 of slack');

  const { host, seen } = recordingOneShotHost();
  const sh = new ProviderShell(host, { cwd: '/w' });
  assert.equal((await sh.run('echo a')).code, 0);
  assert.equal((await sh.run('echo b', { timeoutMs: 100 })).code, 0);
  assert.equal((await sh.run('echo c', { timeoutMs: 900_000 })).code, 0);

  assert.deepEqual(seen, [DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS],
    'an untimed call, and two that name a tighter and a LOOSER bound, all resolve to the ceiling');
});

test('a banner with NO trailing newline still frames — on both streams', async () => {
  // The opening sentinel has to START a line just as the closing ones do. A
  // profile that writes an unterminated banner ('printf MOTD') otherwise glues
  // itself to the marker, which then never matches: the command runs to its
  // deadline instead of returning. And it is EVERY command, because every
  // command gets its own login shell and its own copy of that banner.
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

// PINS THE CEILING'S ONE SURVIVING JOB (card 2026-0312 §2 D-d): a command whose
// sentinel never arrives is BOUNDED, and the bound is enforced by the PROVIDER
// because cc puts the deadline on the `exec` frame. The other two jobs the
// number used to do — capping a wedged shell's lifetime and capping a queued
// command's wait — went with the long-lived shell and the queue.
//
// FAKE-HOST DRIVEN because a real shell cannot be made to swallow its own
// sentinel on demand. The fake answers `timedOut` exactly when the deadline cc
// gave it elapses, which is what a provider that killed the command does.
//
// NOT CLAIMING that any state is reset — there is none to reset, and this branch
// deliberately records no reset reason.
test('a command whose sentinel never arrives is killed at the ceiling, by the provider', async () => {
  const seen = [];
  const { host } = fakeHost({ respond: (cmd) => (cmd === 'wedge' ? { silent: true } : { stdout: cmd }) });
  const inner = host.execOneShot.bind(host);
  host.execOneShot = (spec, opts) => { seen.push(opts.timeoutMs); return inner(spec, opts); };

  const sh = new ProviderShell(host, { cwd: '/w', commandTimeoutMs: 50 });
  await assert.rejects(() => sh.run('wedge'), (e) => {
    assert.equal(e.code, 'ETIMEDOUT', e.message);
    // THE WORDING, not just the code (card 2026-0305 §4 D4): it has to name the
    // ceiling as a ceiling, because the same message is what a worker reads when
    // a legitimately long command hits it. The number is THIS shell's ceiling,
    // so a message carrying a literal fails here.
    //
    // The retired string is deliberately NOT quoted here: the acceptance sweep
    // greps for it expecting zero hits, and a comment holding a copy would make
    // a real regression of the message indistinguishable from this comment.
    assert.match(e.message, /still running after 50ms/, e.message);
    assert.match(e.message, /per-command ceiling/, e.message);
    return true;
  });
  assert.deepEqual(seen, [50], "the deadline reached the provider on the command's own exec frame");

  // …and the next command is untouched: nothing was shared for it to lose.
  const after = await sh.run('echo back');
  assert.equal(after.stdout, 'echo back');
  assert.deepEqual(seen, [50, 50]);
});
