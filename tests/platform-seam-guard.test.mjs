// Static scan: host-OS differences live behind src/platform/. Fails when a
// platform branch, detached spawn, login-shell flag or group kill appears
// elsewhere in the server sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Files W3 gates off on Windows (remote providers and the FUSE union), so they
// never run there. The built-in local System (localSystem.ts, system.ts, ...)
// does run there and is NOT exempt.
const ALLOWED = [
  'src/systems/referenceProvider.ts', // reference remote provider: no remote systems on Windows
  'src/systems/providerSystem.ts',    // remote-provider System client: no remote systems on Windows
  'src/systems/fuse/',                // FUSE-union chroot for remote workers: POSIX-only
  'src/tts.ts',                       // voice: gated off on Windows
  'src/transcribe.ts',                // voice: gated off on Windows
  'src/installRunner.ts',             // voice installers: gated off on Windows
];

const files = [...await walk(path.join(root, 'src')), path.join(root, 'server.ts')]
  .map(f => path.relative(root, f).split(path.sep).join('/'))
  .filter(f => !f.startsWith('src/platform/'));
const sources = new Map(await Promise.all(files.map(async f => [f, await fs.readFile(path.join(root, f), 'utf8')])));

function offenders(re, { allow = true } = {}) {
  return files.filter(f => (!allow || !ALLOWED.some(a => f.startsWith(a))) && re.test(sources.get(f)));
}

test('process.platform appears only under src/platform/', () => {
  assert.deepEqual(offenders(/process\.platform/, { allow: false }), []);
});

test('no detached spawn, login-shell flag or group kill outside src/platform/', () => {
  assert.deepEqual(offenders(/detached:\s*true/), []);
  assert.deepEqual(offenders(/'-lc'/), []);
  assert.deepEqual(offenders(/process\.kill\(-/), []);
});
