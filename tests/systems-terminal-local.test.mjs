// `LocalSystem.openTerminal`: the shared terminal battery in-process, and the
// one refusal that belongs to cc's own host — PTY_UNAVAILABLE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { posixPlatform, win32Platform } from '../src/platform/index.ts';
import { probePtyHelper } from '../src/systems/ptyHost.ts';
import { rmrf } from './rmrf.mjs';
import { terminalBattery } from './terminalBattery.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const probe = await probePtyHelper();

terminalBattery('[local]', {
  open: ({ maxTerminals } = {}) => ({ sys: new LocalSystem(posixPlatform, { maxTerminals }), dispose: () => {} }),
  gate: () => (probe.ok ? null : `this host cannot run the pty helper: ${probe.reason}`),
});

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
