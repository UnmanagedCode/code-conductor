#!/usr/bin/env node
// A provider that is UP when an operation starts and DIES DURING IT.
//
// Every failure fixture before this one made the system unreachable BEFORE the
// call — which is the case that already worked, and the reason a whole class of
// mid-operation defects stayed green. What has to be reproducible is the other
// half: a handshake that succeeds, real work that really happens, and then the
// far side going away partway through a multi-step operation.
//
// So this is a PASSTHROUGH, not a simulator. It spawns the real reference
// provider and pipes both directions, so every frame is genuinely served until
// the moment it decides to die — and when it dies it takes the child with it,
// exactly like a severed transport. What cc sees is a real half-finished
// operation, not a canned error.
//
// Death is chosen by argv, so it is baked into the registry row rather than
// read from an environment the handle may already have been spawned with. Both
// forms count `exec` REQUEST frames, the only frames that do work:
//
//   --budget N     serve exactly N execs, then die BEFORE forwarding the next.
//                  Deterministic: the first N complete normally and the (N+1)th
//                  never runs at all, so a test can assert on both sides.
//   --die-on RE    die immediately after forwarding the first exec whose frame
//                  JSON matches — how you target one specific step of a
//                  multi-step operation, e.g. `git merge`, without having to
//                  count cc's git calls
//   --error-frame RE  answer the first exec whose frame JSON matches with a
//                  protocol `error` frame instead of forwarding it — the far
//                  side saying "that command never started". This is the
//                  COMMAND-level failure, the counterpart of a transport death,
//                  and it is the only way to reach it for a derived op: those
//                  run `env LC_ALL=C …` in `/`, so a real spawn there never
//                  fails. The frame is exactly what a provider emits for an
//                  unstartable command; nothing is simulated but the trigger.
//   --die-stderr S write S to stderr just before dying. cc embeds a dying
//                  provider's stderr TAIL in the refusal it raises, so this is
//                  how a transport death is given text that LOOKS like a local
//                  filesystem answer — the poisoned tail that must not change
//                  how the failure is classified.
//
// `--die-on` forwards the matching frame BEFORE dying, which is the whole
// point: the command really is running on the far side when the transport
// drops, so cc genuinely cannot know whether it completed.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(__dirname, '..', '..', 'src', 'systems', 'referenceProvider.ts');

let budget = null;
let dieOn = null;
let dieStderr = null;
let errorFrame = null;
const passThrough = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--budget') budget = Number(process.argv[++i]);
  else if (process.argv[i] === '--die-on') dieOn = new RegExp(process.argv[++i]);
  else if (process.argv[i] === '--die-stderr') dieStderr = process.argv[++i];
  else if (process.argv[i] === '--error-frame') errorFrame = new RegExp(process.argv[++i]);
  // Anything the wrapper does not claim is the reference provider's, so a test
  // can still ask for a capability configuration through it.
  else passThrough.push(process.argv[i]);
}

const child = spawn(process.execPath, [REFERENCE, ...passThrough], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

// Downstream is a straight pipe: the provider's answers are never touched, so
// anything cc reads is the real provider's own output.
child.stdout.pipe(process.stdout);

function die() {
  // Written synchronously so it is in the pipe before the exit cc observes.
  if (dieStderr) { try { process.stderr.write(dieStderr + '\n'); } catch { /* ignore */ } }
  // SIGKILL, not a graceful close: a transport that drops does not get to
  // flush. The child dies with the wrapper so no orphan keeps serving.
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(0);
}

child.on('exit', () => process.exit(0));

// Upstream is line-delimited JSON, so the wrapper has to reassemble lines to
// count exec frames — it cannot act on a partial frame.
let buf = '';
let execs = 0;

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;

    let isExec = false;
    try { isExec = JSON.parse(line)?.type === 'exec'; } catch { /* forward it anyway */ }

    // Answered here rather than forwarded: the command never reaches the real
    // provider, which is what "never started" means.
    if (isExec && errorFrame?.test(line)) {
      const id = JSON.parse(line).id;
      process.stdout.write(JSON.stringify({
        type: 'error', id, code: 'ENOENT', message: 'spawn env ENOENT',
      }) + '\n');
      continue;
    }

    // The budget dies BEFORE forwarding, so it is deterministic: the exec that
    // exhausts it never runs, and nothing races the wrapper's exit.
    if (isExec && budget !== null && ++execs > budget) die();

    child.stdin.write(line + '\n');

    // `--die-on` is the opposite by design — the frame is already forwarded and
    // the command is really running when the transport drops.
    if (isExec && dieOn?.test(line)) die();
  }
});

process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* ignore */ } });
