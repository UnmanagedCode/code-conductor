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
//   --advertise-mirror <abs>   the advertised mirrorRoot, given directly. The
//                              same thing --mirror-file names; that one exists
//                              only for the case where the answer must survive
//                              a restart and change with it
//   --advertise-exclude <abs>  an advertised exclude entry (repeatable)
//   --exclude-file <path>      advertised excludes, one absolute path per line,
//                              read ONCE at startup for the same reason
//                              --mirror-file is: the list must be able to
//                              change with a RESTART and not within a
//                              generation
//   --extra-field              add a field cc has never heard of to the
//                              `remoteDescriptor` answer
//   --frame-log <path>         append every frame this fixture writes, so a
//                              test can assert what actually went ON THE WIRE
//                              rather than trusting the fixture to have sent it
//   --probe-log <path>         append one line per LIVENESS PROBE received —
//                              an `exec` whose argv is exactly `['true']`.
//                              `--frame-log` records what the fixture WRITES,
//                              so it cannot count an incoming frame, and every
//                              other exec in a spawn is a derivation carrying
//                              `env LC_ALL=C …`: the shape is what identifies
//                              the probe, so counting it counts the probe and
//                              not the traffic beside it
//   --dead-file <path>         while that file EXISTS, answer every `exec` with
//                              an id-addressed ENOREMOTE instead of running it
//                              — the provider is UP and its handshake is the
//                              same generation, but the machine behind it has
//                              gone. Checked PER FRAME, never at startup, which
//                              is the whole point: it is the state cc's
//                              handshake-keyed memoisation cannot see, and the
//                              only way to produce it without a container
//   --ignore-prune             strip the `( -path … ) -prune -o` clause out of
//                              any `exec` argv before running it, emulating a
//                              far side whose `find` does not honour the
//                              operands cc sent. The ONLY way to exercise cc's
//                              per-record gate on its own: against a real
//                              `find`, prune already stopped the record and the
//                              gate never sees one
//
// Every other flag goes to the real provider unchanged.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const takeAll = (flag) => {
  const out = [];
  for (let v = takeValue(flag); v !== null; v = takeValue(flag)) out.push(v);
  return out;
};

const lying = takeFlag('--lie-remote-descriptors');
const extraField = takeFlag('--extra-field');
const mirrorFile = takeValue('--mirror-file');
const pidFile = takeValue('--pid-file');
const frameLog = takeValue('--frame-log');
const ignorePrune = takeFlag('--ignore-prune');
const deadFile = takeValue('--dead-file');
const probeLog = takeValue('--probe-log');
const exclude = takeAll('--advertise-exclude');
const excludeFile = takeValue('--exclude-file');
let mirrorRoot = takeValue('--advertise-mirror');

if (mirrorRoot === null && mirrorFile !== null) {
  try { mirrorRoot = readFileSync(mirrorFile, 'utf8').trim() || null; } catch { /* advertise nothing */ }
}
// READ ONCE, for the same reason `--mirror-file` is: cc memoises the
// advertisement per connection generation, so a list that changed within one
// would model something that cannot happen. One entry per line.
if (excludeFile !== null) {
  try {
    for (const line of readFileSync(excludeFile, 'utf8').split('\n')) {
      if (line.trim() !== '') exclude.push(line.trim());
    }
  } catch { /* advertise no excludes */ }
}
if (pidFile) writeFileSync(pidFile, String(process.pid));

// Advertise the capability only when there is something to say (or a lie to
// tell), so an empty mirror file is byte-identical to a provider that never
// heard of the frame.
const advertises = lying || extraField || mirrorRoot !== null;

process.stdout.on('error', () => process.exit(0));

const write = (frame) => {
  if (frame.type === 'hello' && advertises) {
    frame = { ...frame, capabilities: { ...(frame.capabilities ?? {}), remoteDescriptors: true } };
  }
  // Logged BEFORE the write and after every mutation this fixture makes, so the
  // log is what cc received rather than what the fixture was asked to send.
  if (frameLog) appendFileSync(frameLog, `${JSON.stringify(frame)}\n`);
  process.stdout.write(encodeFrame(frame));
};

// Remove `( -path A -o -path A/* … ) -prune -o` from a find argv, leaving the
// targets and the print action. Not "ignore the flag" — a find that lacked
// -prune would fail the whole command; this is a find that walks everything the
// targets cover, which is what cc's per-record gate has to survive.
function withoutPruneClause(argv) {
  const open = argv.indexOf('(');
  const prune = argv.indexOf('-prune');
  if (open === -1 || prune === -1 || prune < open) return argv;
  const end = argv[prune + 1] === '-o' ? prune + 2 : prune + 1;
  return [...argv.slice(0, open), ...argv.slice(end)];
}

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
    // BEFORE the dead-file arm, so a probe is counted whether it is answered
    // or refused — a count that only saw successes could not tell a refused
    // probe from one that was never made.
    if (probeLog && f.type === 'exec' && Array.isArray(f.argv)
        && f.argv.length === 1 && f.argv[0] === 'true') {
      appendFileSync(probeLog, 'probe\n');
    }
    if (deadFile && f.type === 'exec' && existsSync(deadFile)) {
      write({ type: 'error', id: f.id, code: 'ENOREMOTE',
        message: 'the target is not running' });
      continue;
    }
    if (ignorePrune && f.type === 'exec' && Array.isArray(f.argv)) {
      f.argv = withoutPruneClause(f.argv);
    }
    if (f.type === 'describeRemote' && advertises) {
      write(lying
        ? { type: 'error', id: f.id, code: 'EUNSUPPORTED', message: 'this provider does not describe its remotes after all' }
        : {
          type: 'remoteDescriptor', id: f.id, mirrorRoot, exclude,
          // Neutral, deliberately: this pins that ANY unknown field is inert,
          // not that some particular name is reserved.
          ...(extraField ? { somethingCcHasNeverHeardOf: { nested: [1, 2, 3] } } : {}),
        });
      continue;
    }
    provider.handle(f);
  }
});
process.stdin.on('end', () => { provider.shutdown(); process.exit(0); });
process.stdin.on('close', () => { provider.shutdown(); process.exit(0); });
