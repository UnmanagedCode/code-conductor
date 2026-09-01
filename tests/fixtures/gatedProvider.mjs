#!/usr/bin/env node
// A provider that is UNREACHABLE while a gate FILE exists, and is otherwise the
// real reference provider.
//
//   node gatedProvider.mjs --gate <file> [reference provider flags…]
//
// Every other failure fixture here changes what cc is CONFIGURED with — an argv
// swap (flakyProvider via updateSystem), a row removed, a record rewritten. Each
// of those is a change cc can see: it disposes the live handle, or it moves the
// project record. This fixture exists for the one outage that is invisible to
// both: the box is simply down, and then it is up again, with the registry row,
// the project record and the live handle all untouched throughout.
//
// That is the only shape in which the plugin catalog's "a degraded result is not
// memoized" rule can be observed. Every other route out of a degrade moves the
// placement fingerprint or the generation, so a memoized degraded result would
// be invalidated by the recovery itself and the rule would look like it held
// whether it did or not.
//
// Gated by a FILE rather than by argv on purpose: argv is what cc keys the live
// handle on (handleFor, src/systems/registry.ts), so an argv-carried gate would
// dispose the handle and destroy the very thing being tested.
//
// A passthrough, not a simulator: when the gate is absent every frame is served
// by the real provider, so a test that lifts the gate is running the genuine
// configuration it asked for. When the gate is present the process exits before
// writing a hello, which is exactly what cc sees from a provider it cannot
// reach — ProviderConnection's handshake fails and systemById raises
// SYSTEM_UNREACHABLE.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(__dirname, '..', '..', 'src', 'systems', 'referenceProvider.ts');

let gate = null;
const passThrough = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--gate') gate = process.argv[++i];
  else passThrough.push(process.argv[i]);
}
if (!gate) {
  process.stderr.write('gatedProvider: --gate <file> is required\n');
  process.exit(1);
}

// Checked at STARTUP, so the gate decides reachability for the whole life of
// this process — cc reconnects on its own (ProviderConnection.ensureUp), and the
// next connection re-reads the gate.
if (existsSync(gate)) {
  process.stderr.write(`gatedProvider: gated by ${gate}\n`);
  process.exit(1);
}

const child = spawn(process.execPath, [REFERENCE, ...passThrough], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.on('exit', () => process.exit(0));
