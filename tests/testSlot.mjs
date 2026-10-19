// Box-wide test slots: at most CC_TEST_SLOTS leased suites run at once across
// the whole machine, so concurrent runs queue instead of oversubscribing the CPU.
//
// Every suite sizes itself to the machine and none knows about the others
// (Vitest: availableParallelism() - 1 workers; tests/run.mjs: resolveConcurrency),
// so demand grows linearly with the number of concurrent runs and deadline-bound
// tests time out under load.
//
// WHY DEFAULT_SLOTS IS 2. Measured on a 16-core box (`nproc` 16), whole suites
// through `npm run test:web` / `npm run test:node` / `npm test`, started at load
// <= 20 with no other test process on the box:
//   * a single quiet web suite peaks at 1-minute load ~9.6; the node suite uses
//     ~5.8 cores (resolveConcurrency owns that measurement);
//   * 2 concurrent web suites each take ~53s against ~26.5s alone, so one web suite
//     alone roughly saturates the box and 2 slots are about as fast as running
//     serially (4 web suites: 106-112s at 2 slots, 102s at 1 slot);
//   * without slots, 2 web suites went red in 1 of 2 runs and 4 web suites, 3 web +
//     3 node, and 4 full gates were all red (peak load 68-93: Vitest 5s timeouts);
//     with 2 slots every repeat was green (peak load 31-42).
// It is not 1 because a long run (a mutation campaign) holds its slot for its whole
// duration, and at 1 every other run on the box would queue behind it. Each suite
// keeps its own sizing.
//
// A slot is a loopback TCP port: slot i is `base + i`, and holding it means
// listening on it. The kernel frees the port when the holder dies, SIGKILL
// included, so there is no lock file, no stale-lock detection and no takeover
// race. The holder answers each connection with one JSON line naming itself, so a
// waiter can say who it waits for and tell a holder from a foreign listener.
//
// A lease is taken once per entry point (tests/gate.mjs, tests/run.mjs, the
// Vitest globalSetup tests/vitestSlotSetup.mjs, harness/mutation/run.mjs) and
// everything the holder spawns inherits CC_TEST_SLOT_HELD, which makes a nested
// acquire a no-op: a child never waits on its parent's slot.
import net from 'node:net';

// Below the Linux (32768) and Windows (49152) ephemeral ranges, so no outgoing
// connection is ever handed a slot's port.
export const SLOT_PORT_BASE = 29470;
export const DEFAULT_SLOTS = 2;
export const HELD_VAR = 'CC_TEST_SLOT_HELD';
const MAGIC = 'cc-test-slot/1';
const HOST = '127.0.0.1';
const POLL_MS = 500;
const REPORT_MS = 60_000;
const PROBE_MS = 1000;

// The knobs. A bad value throws; it is never defaulted silently.
export function resolveSlots(env = process.env) {
  const positive = (name, max) => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < 1 || n > max) {
      throw new Error(`${name}=${JSON.stringify(raw)}: expected an integer from 1 to ${max}`);
    }
    return n;
  };
  const slots = positive('CC_TEST_SLOTS', 1024) ?? DEFAULT_SLOTS;
  const base = positive('CC_TEST_SLOT_PORT', 65535) ?? SLOT_PORT_BASE;
  if (base + slots - 1 > 65535) throw new Error(`CC_TEST_SLOT_PORT=${base} with ${slots} slots runs past port 65535`);
  return { slots, base };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A server on `port`, or null when it is taken.
function tryListen(port, info) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end(`${JSON.stringify(info)}\n`);
    });
    server.once('error', (err) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    server.listen({ port, host: HOST, exclusive: true }, () => {
      server.removeAllListeners('error');
      server.on('error', () => {});
      server.unref();
      resolve(server);
    });
  });
}

// Who owns `port`: { holder } for one of ours, { foreign: true } for a listener
// that answered without the magic, { gone: true } when nothing listens any more,
// { silent: true } when nothing answered in time. Silence proves nothing: a real
// holder whose event loop is stalled or stopped is silent too.
function probe(port) {
  return new Promise((resolve) => {
    let data = '';
    const socket = net.connect({ port, host: HOST });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(PROBE_MS, () => done({ silent: true }));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', (err) => done(err.code === 'ECONNREFUSED' ? { gone: true } : { foreign: true }));
    socket.on('close', () => {
      try {
        const info = JSON.parse(data);
        done(info?.magic === MAGIC ? { holder: info } : { foreign: true });
      } catch {
        done({ foreign: true });
      }
    });
  });
}

const NO_LEASE = { release: () => Promise.resolve(), env: {} };

// Take a slot, waiting while every one is held. Resolves { release(), env }; merge
// `env` into the environment of everything spawned while the lease is held.
export async function acquireTestSlot({ label, env = process.env, log = (line) => console.error(line), ...limits } = {}) {
  if (env[HELD_VAR]) return NO_LEASE;
  const { slots, base } = { ...resolveSlots(env), ...limits };
  const info = { magic: MAGIC, pid: process.pid, cwd: process.cwd(), label, since: 0 };
  const foreignLogged = new Set();
  const started = Date.now();
  let lastReport = -Infinity;
  for (;;) {
    const holders = [];
    const silent = [];
    let foreign = 0;
    for (let i = 0; i < slots; i++) {
      const port = base + i;
      for (;;) {
        const server = await tryListen(port, info);
        if (server) {
          info.since = Date.now();
          const waited = Math.round((Date.now() - started) / 1000);
          if (lastReport > -Infinity) log(`test slot: acquired after ${waited}s`);
          return {
            release: () => new Promise((resolve) => server.close(() => resolve())),
            env: { [HELD_VAR]: String(process.pid) },
          };
        }
        const seen = await probe(port);
        if (seen.gone) continue;
        if (seen.holder) holders.push(seen.holder);
        else if (seen.silent) silent.push(port);
        else {
          foreign++;
          if (!foreignLogged.has(port)) {
            foreignLogged.add(port);
            log(`test slot: port ${port} is held by something that is not a test slot — skipping it`);
          }
        }
        break;
      }
    }
    if (foreign === slots) {
      const ports = Array.from({ length: slots }, (_, i) => base + i).join(', ');
      throw new Error(`test slot: every slot port (${ports}) is held by a foreign listener; move the slots with CC_TEST_SLOT_PORT`);
    }
    const now = Date.now();
    if (now - lastReport >= REPORT_MS) {
      lastReport = now;
      const who = holders.map((h) => `${h.label ?? 'unlabelled'} ${h.cwd} pid ${h.pid} for ${Math.round((now - h.since) / 1000)}s`);
      const quiet = silent.length > 0 ? `${who.length > 0 ? '; ' : ''}port ${silent.join(', ')} unresponsive (a stopped or stalled holder?)` : '';
      log(`test slot: waiting — held by ${who.join('; ')}${quiet}`);
    }
    await sleep(POLL_MS + Math.floor(Math.random() * POLL_MS / 2));
  }
}
