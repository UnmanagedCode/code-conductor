#!/usr/bin/env node
// The reference provider with its REMOTE LISTING replaced, IN PROCESS.
//
// The same mechanism as tests/fixtures/mirrorFixtureProvider.mjs: run the real
// `ReferenceProvider` here rather than spawning it, intercept the two frames
// that carry the listing (`hello`'s capabilities and the `listRemotes`
// answer), and pass everything else — the three primitives, the shell, the
// derivations — through untouched.
//
// IN PROCESS, NOT WRAPPED, and that is load-bearing rather than tidy. A wrapper
// puts an extra process between cc and the provider, and cc's `dispose()`
// SIGKILLs what it launched (src/systems/providerConnection.ts `#teardown`) —
// so the kill lands on the wrapper and the real provider is left to notice its
// own stdin closing. That window orphaned a process past the end of a test run
// in 3 of 7 full-suite runs. A signal handler in the wrapper cannot close it,
// because SIGKILL cannot be handled. One process can.
//
//   --advertise-listing   the hello advertises `remotes` and `remoteListing`,
//                         whatever the real provider was configured with
//   --list-file <path>    READ PER ASK: its contents are the raw JSON value of
//                         the answer's `remotes` field, and the literal
//                         `ABSENT` omits the field. Per ask rather than once,
//                         because a listing is a snapshot of a configuration
//                         that changes — and because it is the only way to put
//                         a malformed answer on the wire
//   --list-error <CODE>   answer `listRemotes` with an id-addressed `error` of
//                         that code, message `fixture: configuration unreadable`
//   --mute-listing        never answer `listRemotes` at all
//   --frame-log <path>    append every CLIENT frame received, synchronously,
//                         so a test counts the `listRemotes` frames that
//                         actually crossed the pipe
//
// Every other flag goes to the real provider unchanged. A `listRemotes` none of
// the listing flags claims is the real provider's to answer.

import { appendFileSync, readFileSync } from 'node:fs';
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

const advertise = takeFlag('--advertise-listing');
const mute = takeFlag('--mute-listing');
const listFile = takeValue('--list-file');
const listError = takeValue('--list-error');
const frameLog = takeValue('--frame-log');

process.stdout.on('error', () => process.exit(0));

const write = (frame) => {
  if (frame.type === 'hello' && advertise) {
    frame = { ...frame, capabilities: { ...(frame.capabilities ?? {}), remotes: true, remoteListing: true } };
  }
  process.stdout.write(encodeFrame(frame));
};

function answerListing(f) {
  if (mute) return true;
  if (listError !== null) {
    write({ type: 'error', id: f.id, code: listError, message: 'fixture: configuration unreadable' });
    return true;
  }
  if (listFile !== null) {
    const raw = readFileSync(listFile, 'utf8').trim();
    write(raw === 'ABSENT'
      ? { type: 'remoteList', id: f.id }
      : { type: 'remoteList', id: f.id, remotes: JSON.parse(raw) });
    return true;
  }
  return false;
}

const decoder = new NdjsonDecoder();
let provider;
const fatal = (msg) => {
  process.stderr.write(`remote-list-fixture-provider: ${msg}\n`);
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
    // Synchronous, and before the frame is acted on: the record must be on disk
    // before the answer it provokes reaches cc, or a test that reads it after
    // its own await races.
    if (frameLog) appendFileSync(frameLog, `${JSON.stringify(f)}\n`);
    if (f.type === 'listRemotes' && answerListing(f)) continue;
    provider.handle(f);
  }
});
process.stdin.on('end', () => { provider.shutdown(); process.exit(0); });
process.stdin.on('close', () => { provider.shutdown(); process.exit(0); });
