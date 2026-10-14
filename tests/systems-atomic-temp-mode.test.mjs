// A FILE A WRITE CREATES IS NEVER MORE READABLE THAN THE MODE ASKED FOR.
//
// Every write that creates a file — an `atomic` write's temp file, an
// `exclusive` write's target, a plain write's new target — holds the whole
// payload before its mode is set, so if it is created at the default
// `0o666 & ~umask` and only chmod'ed afterwards, a private file sits
// world-readable for the length of the write. Both of cc's implementations of
// the write are checked: LocalSystem and the reference provider, the latter
// driven IN-PROCESS through its frame handler so the same observation reaches
// it.
//
// THE OBSERVATION IS DETERMINISTIC, not a race: both implementations reach
// `node:fs`'s shared promises object by property, so a spy on its `chmod` sees
// the created file after every byte has landed and before its mode is set —
// the widest it is ever going to be. The umask is pinned so the unfixed default
// (0644) is wider than the 0600 asked for on every host.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { LocalSystem } from '../src/systems/localSystem.ts';
import { ReferenceProvider, parseProviderArgs } from '../src/systems/referenceProvider.ts';

const PAYLOAD = Buffer.from('a private key\n');

// Every chmod'ed file's path and its mode at the pre-chmod moment, while installed.
function spyCreatedModes() {
  const seen = [];
  const original = fsp.chmod;
  fsp.chmod = async (p, mode) => {
    seen.push({ path: String(p), mode: (await fsp.lstat(p)).mode & 0o7777 });
    return original(p, mode);
  };
  return { seen, restore: () => { fsp.chmod = original; } };
}

async function referenceProviderWrite(filePath, data, opts) {
  const frames = [];
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const provider = new ReferenceProvider(parseProviderArgs([]), (f) => {
    frames.push(f);
    if (f.id === 'w1' && (f.type === 'writeFileResult' || f.type === 'error')) settle(f);
  }, (msg) => settle({ type: 'error', message: msg }));
  provider.handle({ type: 'hello', protocol: 1 });
  provider.handle({ type: 'writeFile', id: 'w1', path: filePath, ...opts });
  provider.handle({ type: 'data', id: 'w1', seq: 0, dataB64: data.toString('base64') });
  provider.handle({ type: 'end', id: 'w1' });
  const result = await done;
  provider.shutdown();
  assert.equal(result.type, 'writeFileResult', JSON.stringify(frames));
}

const WRITERS = [
  ['LocalSystem', (p, data, opts) => new LocalSystem().writeFileBytes(p, data, opts)],
  ['reference provider', referenceProviderWrite],
];

// Which file each kind of write creates and chmods — the temp file beside the
// target, or the target itself — and the options that select it.
const KINDS = [
  ['atomic', 'temp file', { atomic: true }, (seenPath, target) => seenPath.startsWith(`${target}.`) && seenPath.endsWith('.tmp')],
  ['exclusive', 'target', { exclusive: true }, (seenPath, target) => seenPath === target],
  ['plain', 'target', {}, (seenPath, target) => seenPath === target],
];

describe('a write creates its file at the requested mode', () => {
  let root, savedUmask, spy;
  beforeEach(async () => {
    root = await fsp.realpath(await mkdtemp('cc-tmpmode-'));
    savedUmask = process.umask(0o022);
  });
  afterEach(() => { spy?.restore(); spy = undefined; process.umask(savedUmask); });

  for (const [name, write] of WRITERS) for (const [kind, what, kindOpts, isCreated] of KINDS) {
    test(`[${name}] ${kind}: the created ${what} never has permission bits wider than \`mode\``, async () => {
      for (const mode of [0o600, 0o640, 0o700]) {
        const target = path.join(root, `${kind}-${mode.toString(8)}`);
        spy = spyCreatedModes();
        await write(target, PAYLOAD, { ...kindOpts, mode });
        spy.restore();
        assert.equal(spy.seen.length, 1, `premise: one file was observed before its chmod (0${mode.toString(8)})`);
        const [seen] = spy.seen;
        assert.ok(isCreated(seen.path, target), `premise: the observed file is the ${what}, got ${seen.path}`);
        assert.equal(seen.mode & ~mode, 0,
          `${what} was 0${seen.mode.toString(8)} while the bytes landed; asked for 0${mode.toString(8)}`);
        assert.equal((await fsp.stat(target)).mode & 0o7777, mode, 'the final mode is exactly the one asked for');
        assert.deepEqual(await fsp.readFile(target), PAYLOAD);
      }
    });
  }
});
