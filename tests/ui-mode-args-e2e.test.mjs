// `--ui` on a real `node server.ts`, for the usage cells and the ordinary
// server's modes: a refused `--ui` exits 2 before anything boots (an ordinary
// server: the message and the synopsis on stderr; a headless run or replay:
// one usage_error object), and GET /api/health advertises each boot's mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshHome as scratchHome, spawnServer, onlyJson, baseOf } from './headlessProcess.mjs';

const freshHome = (t) => scratchHome(t, 'ui-mode-args-');
const SYNOPSIS_LINE = /usage: node server\.ts \(--prompt <text> \| --prompt-file <path\|->\)/;

// Invariant: an ordinary server refuses `--ui interact` and a bad `--ui` with
// exit 2, the cause and the synopsis on stderr, nothing on stdout and no
// listening banner — the refusal happens before boot.
for (const [argv, cause] of [
  [['--ui', 'interact'], /--ui interact needs a headless run/],
  [['--ui'], /--ui needs a value/],
  [['--ui', 'bogus'], /--ui must be one of full \| view \| interact, got 'bogus'/],
  [['--ui', 'view', '--ui', 'view'], /--ui given more than once/],
]) {
  test(`ordinary server ${JSON.stringify(argv)}: exit 2 before boot`, async (t) => {
    const home = await freshHome(t);
    const proc = spawnServer(t, home, argv);
    const { code } = await proc.closed;
    assert.equal(code, 2, proc.out.stderr);
    assert.match(proc.out.stderr, cause);
    assert.match(proc.out.stderr, SYNOPSIS_LINE);
    assert.doesNotMatch(proc.out.stderr, /listening on/);
    assert.equal(proc.out.stdout, '');
  });
}

// Invariant: an ordinary server with no `--ui` advertises uiMode full, no focus
// and capabilities without viewOnly; `--ui=view` (the `=` spelling) advertises
// view and logs the mode after the banner.
test('ordinary server: default full, --ui=view advertises view', async (t) => {
  for (const [argv, mode] of [[[], 'full'], [['--ui=view'], 'view']]) {
    const home = await freshHome(t);
    const proc = spawnServer(t, home, argv);
    const base = await baseOf(proc);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.uiMode, mode);
    assert.equal('focus' in health, false);
    assert.equal('viewOnly' in health.capabilities, false);
    if (mode === 'view') assert.match(proc.out.stderr + proc.out.stdout, /UI mode: view/);
    proc.child.kill('SIGTERM');
    await proc.closed;
  }
});

// Invariant: a headless run or replay with a bad `--ui` (or a replay flag
// misused beside `--ui`) prints one usage_error object, exit 2, and boots nothing.
for (const argv of [
  ['--prompt', 'x', '--ui', 'bogus'],
  ['--replay', '--ui'],
  ['--session', 's', '--ui', 'view'],
  ['--replay', '--prompt', 'x'],
]) {
  test(`headless ${JSON.stringify(argv)}: one usage_error, exit 2`, async (t) => {
    const home = await freshHome(t);
    const proc = spawnServer(t, home, argv);
    const { code } = await proc.closed;
    assert.equal(code, 2, proc.out.stderr);
    const res = onlyJson(proc.out.stdout);
    assert.equal(res.reason, 'usage_error');
    assert.equal(res.exitCode, 2);
    assert.doesNotMatch(proc.out.stderr, /listening on/);
  });
}
