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

// Files that stay imported on every platform but run only behind a capability
// (`Platform.capabilities`), so they never run where the host turns it off. The
// built-in local System (localSystem.ts, system.ts, ...) does run everywhere and
// is NOT exempt.
const ALLOWED = [
  'src/systems/referenceProvider.ts', // never imported by src/; runs as a provider process
  'src/systems/providerSystem.ts',    // built only for a registered non-local row (none can be added with remoteSystems off) or the CC_LOCAL_SYSTEM_PROVIDER test seam
  'src/systems/fuse/',                // imported, but run only for a remote session (refused FUSE_UNAVAILABLE with fuseUnion off) or the boot sweep (skipped with it off)
  'src/tts.ts',                       // run only behind routes refused VOICE_UNAVAILABLE with voice off
  'src/transcribe.ts',                // run only behind routes refused VOICE_UNAVAILABLE with voice off
  'src/installRunner.ts',             // run only behind the voice install routes, refused VOICE_UNAVAILABLE with voice off
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
