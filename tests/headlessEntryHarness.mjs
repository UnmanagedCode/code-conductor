// headlessMain (src/headless/entry.ts) in its own process with a stub boot, so
// tests/headless-entry.test.mjs can drive the entry's failure paths without a
// real server:
//
//   node tests/headlessEntryHarness.mjs <case> -- <headless argv…>
//
//   boot-throws        start() rejects with a plain Error
//   stray-throw        start() resolves; something outside the runner throws later
//   runner-throws      the runner's own wiring throws after the root is spawned
//   signal-then-throw  a SIGINT arrives, then the root's interrupt throws
//   completes          the run completes normally
//
// When the result is written, the harness prints the process's SIGINT and
// SIGTERM listener counts to stderr (`LISTENERS SIGINT=<n> SIGTERM=<n>`).
//
// PROJECTS_ROOT must point at a scratch root: the runner's spawn resolves the
// Conductor role from that root's settings.
import { headlessMain } from '../src/headless/entry.ts';
import { parseHeadlessArgs } from '../src/headless/args.ts';

const [kase, sep, ...argv] = process.argv.slice(2);
if (sep !== '--') throw new Error('usage: headlessEntryHarness.mjs <case> -- <argv…>');

function fakeRoot(over = {}) {
  return {
    id: 'root', sessionId: 'root-session', status: 'idle', mode: 'bypassPermissions',
    ringSnapshot: () => [{ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'fake root text', _seq: 1 }],
    summary: () => ({ id: 'root', status: 'idle' }),
    promptOrQueueSteer: async () => {},
    interrupt: async () => {},
    ...over,
  };
}
function fakeInstances(root, over = {}) {
  return { create: async () => root, on() {}, off() {}, isTreeQuiescent: () => false, exitCauseFor: () => null, ...over };
}
const booted = (instances) => ({ instances, host: '127.0.0.1', port: 1 });

const starts = {
  'boot-throws': async () => { throw new Error('boom at boot'); },
  'stray-throw': async () => {
    setTimeout(() => { throw new Error('a stray throw'); }, 20);
    return booted(fakeInstances(fakeRoot()));
  },
  'runner-throws': async () => booted(fakeInstances(fakeRoot(), { on() { throw new Error('listener wiring failed'); } })),
  completes: async () => booted(fakeInstances(fakeRoot(), { isTreeQuiescent: () => true })),
  'signal-then-throw': async () => booted(fakeInstances(fakeRoot({
    promptOrQueueSteer: async () => { setTimeout(() => process.kill(process.pid, 'SIGINT'), 20); },
    interrupt: () => { throw new Error('interrupt exploded'); },
  }))),
};
const start = starts[kase];
if (!start) throw new Error(`unknown case ${kase}`);
const args = parseHeadlessArgs(argv);
if (args.kind === 'none') throw new Error('the harness needs a headless argv');
// Wrapped before headlessMain captures it: the write of the result is the
// moment the listener counts are taken.
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  process.stderr.write(`LISTENERS SIGINT=${process.listenerCount('SIGINT')} SIGTERM=${process.listenerCount('SIGTERM')}\n`);
  return realWrite(chunk, ...rest);
};
// A real run's server sockets keep the event loop alive; the stub boot has
// none, and node's signal watchers do not count.
setInterval(() => {}, 1_000);
void headlessMain(args, { start });
