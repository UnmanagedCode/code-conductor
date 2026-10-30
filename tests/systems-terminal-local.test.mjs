// `LocalSystem.openTerminal`: the shared terminal battery in-process, and the
// one refusal that belongs to cc's own host — PTY_UNAVAILABLE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { posixPlatform, win32Platform } from '../src/platform/index.ts';
import { probePtyHelper } from '../src/systems/ptyHost.ts';
import { rmrf } from './rmrf.mjs';
import { TERMINAL_ROWS, alive, settle, terminalRowTest } from './terminalBattery.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const probe = await probePtyHelper();

// The shared battery, each row registered HERE so its test id is this file's.
for (const row of TERMINAL_ROWS) {
  test(`[local] ${row.name}`, terminalRowTest(row, {
    open: ({ maxTerminals } = {}) => ({ sys: new LocalSystem(posixPlatform, { maxTerminals }), dispose: () => {} }),
    gate: () => (probe.ok ? null : `this host cannot run the pty helper: ${probe.reason}`),
  }));
}

async function withDir(fn) {
  const dir = await mkdtemp('cc-terminal-refusal-');
  try { return await fn(await fs.realpath(dir)); }
  finally { await rmrf(dir); }
}

// PINS: on a platform with no pty helper (Windows) the open is REFUSED by name —
// 501 PTY_UNAVAILABLE — and nothing is spawned.
test('a platform with no pty helper refuses PTY_UNAVAILABLE', async () => {
  assert.equal(win32Platform.terminalShell(), null, 'Windows has no local terminal');
  await withDir(async (cwd) => {
    await assert.rejects(
      new LocalSystem(win32Platform).openTerminal({ cwd, argv: ['true'], cols: 80, rows: 24, term: 'xterm' },
        { onData() {}, onExit() {} }),
      (e) => e.statusCode === 501 && e.code === 'PTY_UNAVAILABLE' && /platform/.test(e.message));
  });
});

// PINS: a host whose interpreter is missing is refused by name, and the message
// names the interpreter and that a restart re-checks.
test('a host without the interpreter refuses PTY_UNAVAILABLE naming it', async () => {
  const python = 'python3-absent-cc-terminal-test';
  await withDir(async (cwd) => {
    await assert.rejects(
      new LocalSystem(posixPlatform, { ptyPython: python })
        .openTerminal({ cwd, argv: ['true'], cols: 80, rows: 24, term: 'xterm' }, { onData() {}, onExit() {} }),
      (e) => e.statusCode === 501 && e.code === 'PTY_UNAVAILABLE'
        && e.message.includes(`${python} not found on PATH`) && /restart/.test(e.message));
  });
});

// PINS: a local open is BOUNDED. An interpreter that passes the probe and then
// never starts the program rejects the open ETIMEDOUT, its helper process is
// killed, and its slot is freed — with a cap of ONE, the second attempt times
// out too, never TERMINAL_LIMIT.
test('a helper that never starts the program rejects ETIMEDOUT, is killed and frees the slot', async () => {
  await withDir(async (cwd) => {
    const fake = path.join(cwd, 'python3-that-never-answers');
    // The probe (`-I -c …`) is answered with the script's own absolute path;
    // the helper run records its pid and then hangs.
    await fs.writeFile(fake, [
      '#!/bin/sh',
      'case "$1 $2" in "-I -c") echo "$0"; exit 0;; esac',
      'echo $$ >> "$(dirname "$0")/helper.pids"',
      'exec sleep 1000',
      '',
    ].join('\n'), { mode: 0o755 });
    const sys = new LocalSystem(posixPlatform, { ptyPython: fake, maxTerminals: 1, terminalOpenTimeoutMs: 300 });
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        sys.openTerminal({ cwd, argv: ['true'], cols: 80, rows: 24, term: 'xterm' }, { onData() {}, onExit() {} }),
        (e) => e.name === 'SystemError' && e.code === 'ETIMEDOUT' && /300ms/.test(e.message), `attempt ${i}`);
    }
    const pids = (await fs.readFile(path.join(cwd, 'helper.pids'), 'utf8')).trim().split('\n').map(Number);
    assert.equal(pids.length, 2, 'each attempt really spawned the helper');
    assert.ok(await settle(() => pids.every((p) => !alive(p))), `the hung helpers (${pids}) were killed`);
  });
});
