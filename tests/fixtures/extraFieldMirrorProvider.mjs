#!/usr/bin/env node
// A provider whose `remoteDescriptor` carries a field cc does not know about.
//
// Unknown fields on a known frame are the extension point that lets this
// contract grow without a version bump, and the direction matters: a
// provider→cc field cc ignores has no failure mode, unlike a cc→provider field
// an older provider would silently misread. This fixture is the evidence for
// that half, so a later reader cannot "tighten" the decode into a rejection.
//
// A passthrough around the reference provider; everything else is the real
// thing.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(__dirname, '..', '..', 'src', 'systems', 'referenceProvider.ts');

const child = spawn(process.execPath, [REFERENCE, ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
child.on('exit', () => process.exit(0));

let out = '';
child.stdout.on('data', (chunk) => {
  out += chunk.toString('utf8');
  let nl;
  while ((nl = out.indexOf('\n')) >= 0) {
    const line = out.slice(0, nl);
    out = out.slice(nl + 1);
    if (!line.trim()) continue;
    const f = JSON.parse(line);
    if (f.type === 'hello') f.capabilities = { ...(f.capabilities ?? {}), remoteDescriptors: true };
    process.stdout.write(`${JSON.stringify(f)}\n`);
  }
});

let inb = '';
process.stdin.on('data', (chunk) => {
  inb += chunk.toString('utf8');
  let nl;
  while ((nl = inb.indexOf('\n')) >= 0) {
    const line = inb.slice(0, nl);
    inb = inb.slice(nl + 1);
    if (!line.trim()) continue;
    const f = JSON.parse(line);
    if (f.type === 'describeRemote') {
      process.stdout.write(`${JSON.stringify({
        type: 'remoteDescriptor', id: f.id,
        mirrorRoot: '/srv', exclude: ['/srv/tmp'],
        // Neutral, deliberately: this pins that ANY unknown field is inert, not
        // that some particular name is reserved.
        somethingCcHasNeverHeardOf: { nested: [1, 2, 3] },
      })}\n`);
      continue;
    }
    child.stdin.write(`${line}\n`);
  }
});
process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* ignore */ } });
