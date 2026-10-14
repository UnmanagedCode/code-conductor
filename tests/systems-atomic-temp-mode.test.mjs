// AN ATOMIC WRITE'S TEMP FILE IS NEVER MORE READABLE THAN THE MODE ASKED FOR.
//
// The temp file holds the whole payload before the rename installs it, so if
// it is created at the default `0o666 & ~umask` and only chmod'ed afterwards, a
// private file sits world-readable under a predictable name for the length of
// the write. Both of cc's implementations of the write are checked: LocalSystem
// and the reference provider, the latter driven IN-PROCESS through its frame
// handler so the same observation reaches it.
//
// THE OBSERVATION IS DETERMINISTIC, not a race: both implementations reach
// `node:fs`'s shared promises object by property, so a spy on its `chmod` sees
// the temp file after every byte has landed and before its mode is set — the
// widest it is ever going to be. The umask is pinned so the unfixed default
// (0644) is wider than the 0600 asked for on every host.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { ReferenceProvider, parseProviderArgs } from '../src/systems/referenceProvider.ts';

const PAYLOAD = Buffer.from('a private key\n');

// Every temp-file mode seen at its pre-chmod moment, while installed.
function spyTempModes() {
  const seen = [];
  const original = fsp.chmod;
  fsp.chmod = async (p, mode) => {
    if (String(p).endsWith('.tmp')) seen.push((await fsp.lstat(p)).mode & 0o7777);
    return original(p, mode);
  };
  return { seen, restore: () => { fsp.chmod = original; } };
}

async function referenceProviderWrite(filePath, data, mode) {
  const frames = [];
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const provider = new ReferenceProvider(parseProviderArgs([]), (f) => {
    frames.push(f);
    if (f.id === 'w1' && (f.type === 'writeFileResult' || f.type === 'error')) settle(f);
  }, (msg) => settle({ type: 'error', message: msg }));
  provider.handle({ type: 'hello', protocol: 1 });
  provider.handle({ type: 'writeFile', id: 'w1', path: filePath, mode, atomic: true });
  provider.handle({ type: 'data', id: 'w1', seq: 0, dataB64: data.toString('base64') });
  provider.handle({ type: 'end', id: 'w1' });
  const result = await done;
  provider.shutdown();
  assert.equal(result.type, 'writeFileResult', JSON.stringify(frames));
}

const WRITERS = [
  ['LocalSystem', (p, data, mode) => new LocalSystem().writeFileBytes(p, data, { atomic: true, mode })],
  ['reference provider', referenceProviderWrite],
];

describe('an atomic write creates its temp file at the requested mode', () => {
  let root, savedUmask, spy;
  beforeEach(async () => {
    root = await fsp.realpath(await mkdtemp('cc-tmpmode-'));
    savedUmask = process.umask(0o022);
  });
  afterEach(() => { spy?.restore(); spy = undefined; process.umask(savedUmask); });

  for (const [name, write] of WRITERS) {
    test(`[${name}] a temp file never has permission bits wider than \`mode\``, async () => {
      for (const mode of [0o600, 0o640, 0o700]) {
        const target = path.join(root, `out-${mode.toString(8)}`);
        spy = spyTempModes();
        await write(target, PAYLOAD, mode);
        spy.restore();
        assert.equal(spy.seen.length, 1, `premise: the temp file was observed once before its chmod (0${mode.toString(8)})`);
        const [tmpMode] = spy.seen;
        assert.equal(tmpMode & ~mode, 0,
          `temp file was 0${tmpMode.toString(8)} while the bytes landed; asked for 0${mode.toString(8)}`);
        assert.equal((await fsp.stat(target)).mode & 0o7777, mode, 'the final mode is exactly the one asked for');
        assert.deepEqual(await fsp.readFile(target), PAYLOAD);
      }
    });
  }
});
