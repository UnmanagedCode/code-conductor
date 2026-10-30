// A terminal through the `local` handle — the one `npm run gate:systems`
// replaces with a provider. In-process it runs LocalSystem; under the gate it
// runs the protocol's pty exec in row 1 and the `pty:false` fallback in row 2
// (`--no-pty`). This file is what makes the gate's pty fold MEAN something:
// nothing else in the application opens a terminal yet.
//
// What it expects is derived from the configuration, never from the handle
// under test: in-process, the host's probe decides; over the reference
// provider, its `--no-pty` flag and the same probe do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { LOCAL_SYSTEM_ID, systemById } from '../src/systems/registry.ts';
import { rmrf } from './rmrf.mjs';
import { expectedLocalTerminalRefusal, openSession } from './terminalBattery.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

// PINS: `openTerminal` on the `local` handle opens a working terminal exactly
// when its configuration supports one, and is otherwise refused by the name
// that configuration owes — PTY_UNAVAILABLE in-process, SYSTEM_NO_PTY over a
// provider without `pty`.
test('a terminal on the local handle works or is refused by name', async () => {
  const dir = await mkdtemp('cc-terminal-seam-');
  try {
    const cwd = await fs.realpath(dir);
    const sys = await systemById(LOCAL_SYSTEM_ID, null, 'the terminal seam test');
    // `local` comes back unconnected; a third-party provider's expectation is
    // read off its handshake, so make one first.
    if (typeof sys.connect === 'function') await sys.connect();
    const refusal = expectedLocalTerminalRefusal(sys);
    if (refusal !== null) {
      await assert.rejects(openSession(sys, { cwd, argv: ['cat'] }),
        (e) => e.statusCode === 501 && e.code === refusal, `expected ${refusal}`);
      return;
    }
    const s = await openSession(sys, { cwd, argv: ['cat'] });
    s.terminal.write('seam-check\n');
    await s.until(/seam-check\r\nseam-check\r\n/);
    s.terminal.write('\x04');
    assert.deepEqual((await s.ended).end, { kind: 'exited', code: 0, signal: null });
  } finally {
    await rmrf(dir);
  }
});
