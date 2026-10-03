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
  'src/systems/providerSystem.ts',    // built for a registered non-local row (none can be added through the API with remoteSystems off; a settings.json copied from another host can still carry one, whose provider is then run by read paths) or the CC_LOCAL_SYSTEM_PROVIDER test seam
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

// A `/.claude/…` or `/.code-conductor/…` fragment in a literal or regex is
// matched against host paths, which on Windows use `\`. Use `[\\/]`.
const FRAGMENT_RE = /(?<!~)\\?\/\\?\.(?:claude|code-conductor)\b/;
const DISPLAY_TEXT = [
  '<projectsRoot>/.code-conductor/playbooks/',   // tool description shown to the model
];

test('no `/`-separated .claude / .code-conductor fragment in a literal', () => {
  const hits = [];
  for (const f of files) {
    for (const line of sources.get(f).split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (FRAGMENT_RE.test(line) && !DISPLAY_TEXT.some(s => line.includes(s))) hits.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, []);
});

// A holder (a class or `createX` factory, or createServer/start) defaults its
// platform to `hostPlatform` once and forwards it to every helper it calls; a
// helper takes `platform` as a required parameter, so a holder that forgets to
// forward fails the typecheck. A `hostPlatform` default anywhere else is a helper
// silently falling back to the host. File → count of defaults it may hold.
const HOLDERS = {
  'server.ts': 2,                  // createServer, start
  'src/instances.ts': 2,           // Instance, InstanceManager
  'src/claudeLauncher.ts': 1,      // RealClaudeLauncher
  'src/systems/localSystem.ts': 1, // LocalSystem
  'src/plugins/registry.ts': 1,    // createPluginHost
  'src/plugins/supervisor.ts': 1,  // createSupervisor
  'src/plugins/library.ts': 1,     // createPluginLibrary
};

test('a `hostPlatform` default appears only on a holder', () => {
  const counts = {};
  for (const f of files) {
    const n = [...sources.get(f).matchAll(/(?<![=!<>])=\s*hostPlatform\b(?!\.)/g)].length;
    if (n) counts[f] = n;
  }
  assert.deepEqual(counts, HOLDERS);
});

test('nothing assigns to a `hostPlatform` member', async () => {
  const testFiles = (await fs.readdir(path.join(root, 'tests'))).filter(n => n.endsWith('.mjs')).map(n => `tests/${n}`);
  const all = new Map(sources);
  for (const f of testFiles) all.set(f, await fs.readFile(path.join(root, f), 'utf8'));
  const hits = [...all].filter(([, src]) => /hostPlatform\.\w+\s*=(?!=)/.test(src)).map(([f]) => f);
  assert.deepEqual(hits, []);
});
