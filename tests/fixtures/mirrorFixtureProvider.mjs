#!/usr/bin/env node
// The reference provider with its mirror advertisement REPLACED, IN PROCESS.
//
// Two fixtures in one file because they are one mechanism: run the real
// `ReferenceProvider` here rather than spawning it, intercept the two frames
// that carry the advertisement (`hello`'s capabilities and `describeRemote`'s
// answer), and pass everything else — the three primitives, the shell, the
// derivations — through untouched.
//
// IN PROCESS, NOT WRAPPED, and that is load-bearing rather than tidy. A wrapper
// puts an extra process between cc and the provider, and cc's `dispose()`
// SIGKILLs what it launched (src/systems/providerConnection.ts `#teardown`) —
// so the kill lands on the wrapper and the real provider is left to notice its
// own stdin closing. Measured: that window is real, and it orphaned a process
// past the end of a test run in 3 of 7 full-suite runs. A signal handler in the
// wrapper cannot close it, because SIGKILL cannot be handled. One process can.
//
//   --lie-remote-descriptors   advertise `remoteDescriptors` and then answer
//                              the frame EUNSUPPORTED — a provider that lies
//                              about its own capability
//   --mirror-file <path>       read ONCE at startup; the advertised mirrorRoot,
//                              or nothing when empty/absent. Read once because
//                              cc memoises the answer per connection
//                              generation, so an answer that changed within one
//                              would model something that cannot happen — only
//                              a restart may change it
//   --pid-file <path>          this process's pid, so a test can end a
//                              generation deliberately rather than by waiting
//
// Every other flag goes to the real provider unchanged.

import { readFileSync, writeFileSync } from 'node:fs';
import { NdjsonDecoder, SystemError, encodeFrame } from '../../src/systems/protocol.ts';
import { ReferenceProvider, parseProviderArgs } from '../../src/systems/referenceProvider.ts';

const argv = process.argv.slice(2);
const takeFlag = (flag) => {
  const i = argv.indexOf(flag);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};
const takeValue = (flag) => {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1] ?? null;
  argv.splice(i, 2);
  return v;
};

const lying = takeFlag('--lie-remote-descriptors');
const mirrorFile = takeValue('--mirror-file');
const pidFile = takeValue('--pid-file');

let mirrorRoot = null;
if (mirrorFile !== null) {
  try { mirrorRoot = readFileSync(mirrorFile, 'utf8').trim() || null; } catch { /* advertise nothing */ }
}
if (pidFile) writeFileSync(pidFile, String(process.pid));

// Advertise the capability only when there is something to say (or a lie to
// tell), so an empty mirror file is byte-identical to a provider that never
// heard of the frame.
const advertises = lying || mirrorRoot !== null;

process.stdout.on('error', () => process.exit(0));

const write = (frame) => {
  if (frame.type === 'hello' && advertises) {
    frame = { ...frame, capabilities: { ...(frame.capabilities ?? {}), remoteDescriptors: true } };
  }
  process.stdout.write(encodeFrame(frame));
};

const decoder = new NdjsonDecoder();
let provider;
const fatal = (msg) => {
  process.stderr.write(`mirror-fixture-provider: ${msg}\n`);
  provider.shutdown();
  process.exit(1);
};
provider = new ReferenceProvider(parseProviderArgs(argv), write, fatal);

process.stdin.on('data', (chunk) => {
  let frames;
  try { frames = decoder.push(chunk); }
  catch (e) {
    write({ type: 'error', code: e instanceof SystemError ? e.code : 'EPROTO', message: String(e?.message ?? e) });
    fatal(String(e?.message ?? e));
    return;
  }
  for (const f of frames) {
    if (f.type === 'describeRemote' && advertises) {
      write(lying
        ? { type: 'error', id: f.id, code: 'EUNSUPPORTED', message: 'this provider does not describe its remotes after all' }
        : { type: 'remoteDescriptor', id: f.id, mirrorRoot });
      continue;
    }
    provider.handle(f);
  }
});
process.stdin.on('end', () => { provider.shutdown(); process.exit(0); });
process.stdin.on('close', () => { provider.shutdown(); process.exit(0); });
