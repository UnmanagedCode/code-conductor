// Box-wide test slots: at most CC_TEST_SLOTS leased suites run at once across
// the whole machine, so concurrent runs queue instead of oversubscribing the CPU.
//
// Every suite sizes itself to the core count (Vitest: one worker per core;
// tests/run.mjs: resolveConcurrency) and none knows about the others, so demand
// grows linearly with the number of concurrent runs and deadline-bound tests
// (Vitest's 5s default among them) time out under load. One suite does not fill a
// 16-core box; two roughly do; three or more oversubscribe it. The default of 2
// is that bound, each suite keeping its own per-core sizing.
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

// Who owns `port`: { holder } for one of ours, { foreign: true } for anything
// else, { gone: true } when nothing listens any more.
function probe(port) {
  return new Promise((resolve) => {
    let data = '';
    const socket = net.connect({ port, host: HOST });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(PROBE_MS, () => done({ foreign: true }));
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
  const info = { magic: MAGIC, pid: process.pid, cwd: process.cwd(), label, since: Date.now() };
  const foreignLogged = new Set();
  const started = Date.now();
  let lastReport = -Infinity;
  for (;;) {
    const holders = [];
    let foreign = 0;
    for (let i = 0; i < slots; i++) {
      const port = base + i;
      for (;;) {
        const server = await tryListen(port, info);
        if (server) {
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
      log(`test slot: waiting — held by ${who.join('; ')}`);
    }
    await sleep(POLL_MS + Math.floor(Math.random() * POLL_MS / 2));
  }
}
