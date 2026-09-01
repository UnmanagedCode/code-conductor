#!/usr/bin/env node
// A provider that PARKS ITS HANDSHAKE until a release file appears, and is
// otherwise the real reference provider.
//
//   node slowHelloProvider.mjs --release <file> [reference provider flags…]
//
// Its whole purpose is to hold a caller INSIDE an operation long enough for
// another gesture to land mid-flight. cc's plugin catalog resolves a
// contributing project's placement per compose, and that resolution connects:
// `resolvePlacement` → `resolveProjectDir` → `systemById` → `connect()` →
// ProviderConnection's handshake. Parking the hello parks a compose exactly
// there, with the scan loop half-finished — the only way to observe what an
// invalidation landing mid-scan does to the fragment-body cache.
//
// PARKS THE ANSWER, NOT THE SPAWN: the child is started and cc's stdin is piped
// to it immediately, so the plumbing (and, critically, the stdin-EOF reap that
// stops a provider being orphaned) is identical to every other passthrough
// fixture here. Only the child's STDOUT is withheld, which is what a slow far
// side looks like from cc's side of the pipe. `child.stdout` is not piped until
// released, and a Readable with no consumer buffers rather than drops, so the
// hello is delivered intact the moment the gate lifts.
//
// The park is deliberately shorter-lived than ProviderConnection's handshake
// timeout in every test that uses it: past that the connection fails, which is a
// different fixture's job (gatedProvider.mjs).
//
// It touches `<release>.parked` when it begins waiting, so a test can wait for
// the park to be REAL rather than sleeping and hoping. Without that the whole
// instrument is a race.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(__dirname, '..', '..', 'src', 'systems', 'referenceProvider.ts');

let release = null;
const passThrough = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--release') release = process.argv[++i];
  else passThrough.push(process.argv[i]);
}
if (!release) {
  process.stderr.write('slowHelloProvider: --release <file> is required\n');
  process.exit(1);
}

const child = spawn(process.execPath, [REFERENCE, ...passThrough], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
// Both directions of the reap: cc's EOF reaches the real provider, and the real
// provider going away takes this wrapper with it.
process.stdin.pipe(child.stdin);
child.on('exit', () => { clearInterval(timer); process.exit(0); });

function open() {
  child.stdout.pipe(process.stdout);
}

let timer = null;
if (existsSync(release)) {
  open();
} else {
  writeFileSync(`${release}.parked`, '');
  timer = setInterval(() => {
    if (!existsSync(release)) return;
    clearInterval(timer);
    timer = null;
    open();
  }, 10);
}
