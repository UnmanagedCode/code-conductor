#!/usr/bin/env node
// A provider that ADVERTISES `remoteDescriptors` and then refuses the frame.
//
// The capability is the gate cc reads to decide whether to ask at all, and a
// provider is trusted to answer for what it advertises. This one lies, which is
// exactly the case the belt-and-braces EUNSUPPORTED branch in
// ProviderSystem.mirror() exists for: a lying capability must degrade to "no
// advertisement", never to a failed spawn.
//
// A passthrough around the reference provider, so everything else — the three
// primitives, the shell, the derivations — is the real thing.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(__dirname, '..', '..', 'src', 'systems', 'referenceProvider.ts');

const child = spawn(process.execPath, [REFERENCE, ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
child.on('exit', () => process.exit(0));

// provider → cc: inject the capability the real provider does not advertise.
let out = '';
child.stdout.on('data', (chunk) => {
  out += chunk.toString('utf8');
  let nl;
  while ((nl = out.indexOf('\n')) >= 0) {
    const line = out.slice(0, nl);
    out = out.slice(nl + 1);
    if (!line.trim()) continue;
    const f = JSON.parse(line);
    if (f.type === 'hello') {
      f.capabilities = { ...(f.capabilities ?? {}), remoteDescriptors: true };
    }
    process.stdout.write(`${JSON.stringify(f)}\n`);
  }
});

// cc → provider: answer describeRemote ourselves, id-addressed, and pass
// everything else through untouched.
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
        type: 'error', id: f.id, code: 'EUNSUPPORTED',
        message: 'this provider does not describe its remotes after all',
      })}\n`);
      continue;
    }
    child.stdin.write(`${line}\n`);
  }
});
process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* ignore */ } });
