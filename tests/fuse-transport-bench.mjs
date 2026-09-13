// WHAT THE TRANSPORT COSTS — the instrument, not an assertion.
//
// Deliberately NOT a `.test.mjs`: tests/run.mjs's discovery never picks it up
// and `npm test` never pays for it. Nothing here passes or fails; it prints
// numbers, and the numbers are the deliverable.
//
//   node tests/fuse-transport-bench.mjs --case fetch-cold --arm localdir --sizes 1k,64k,1m --runs 30
//
// THE ONE VARIABLE BETWEEN ARMS IS THE `RemoteSource`. Same ControlServer, same
// unix socket, same frames, same mirror — so a delta is the source's and
// nothing else's:
//
//   --arm localdir   `localDirSource(<tmpdir>)`. THE CONTROL: the cost with no
//                    provider and no transport in the path.
//   --arm reference  `systemSource` over a ProviderSystem on the reference
//                    provider — the whole NDJSON → base64 → 64 KiB chunking
//                    path, deterministic and in-repo, which isolates the
//                    PROTOCOL's cost from a container's.
//   --case write-close  M3: one written file's close sequence — the `flush`
//                    that lands the bytes and the `release` that drops the
//                    claim — with `--release-only {on,off}`. `off` is the
//                    BEFORE picture (a flags-0 release frame) and is a
//                    BENCH-ONLY switch, never a product knob.
//   --arm docker     a REAL docker remote, measured and not asserted. Needs
//                    that container up. Its
//                    fixtures are built ON THE BOX through the same handle,
//                    because there is no shared filesystem to build them on.
//                    IT TAKES TWO REQUIRED INPUTS and refuses loudly without
//                    them, because a machine-specific default baked in here is
//                    a number whose configuration is unstated:
//                      --provider-argv  (or CC_FUSE_BENCH_PROVIDER_ARGV) — the
//                        argv of the System provider to launch, space-separated,
//                        e.g. `node /path/to/launcher.mjs --kind docker`.
//                      --remote         (or CC_FUSE_BENCH_REMOTE) — the remote
//                        handle name to bind on that provider, i.e. the
//                        container.
//                    `--box-root` (default /root/cc-bench) is where fixtures
//                    are built on the box.
//
// MEDIAN AND p90, NEVER A MEAN: one GC pause skews a mean and says nothing
// about the distribution a worker actually meets.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ControlServer, encodeRequest, CCU_OP, CCU_STATUS, CCU_REPLY_LEN,
  CCU_FLAG_FOR_WRITE, CCU_FLAG_RELEASE_ONLY } from '../src/systems/fuse/control.ts';
import { localDirSource } from '../src/systems/fuse/remoteSource.ts';
import { systemSource } from '../src/systems/fuse/systemSource.ts';
import { ProviderSystem } from '../src/systems/providerSystem.ts';
import { buildTierTable } from '../src/systems/fuse/tierTable.ts';
import { tierFixtureInput } from './tierFixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_PROVIDER = path.join(HERE, '..', 'src', 'systems', 'referenceProvider.ts');
const RECORDER = path.join(HERE, 'recordingProvider.mjs');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1]; };
const flag = (name) => argv.includes(name);

// FRAME COUNTING, off unless asked: the recorder puts a relay process in front
// of the provider, which is a variable a latency arm must not carry. A pass
// with `--log` is a COUNT pass, and its milliseconds are not comparable to one
// without.
const LOG = opt('--log', '');
const CASE = opt('--case', 'fetch-cold');
const ARM = opt('--arm', 'localdir');
const RUNS = Number(opt('--runs', '30'));
const SIZES = opt('--sizes', '1k,64k,1m').split(',');
const CHILDREN = opt('--children', '1,10,50,200').split(',').map(Number);
const SHAPE = opt('--shape', 'one-call');
// M3's before/after switch. `on` is what the daemon sends; `off` reproduces the
// pre-RELEASE_ONLY release frame. BENCH ONLY.
const RELEASE_ONLY = opt('--release-only', 'on') !== 'off';

const BYTES = { '1k': 1024, '64k': 64 * 1024, '1m': 1024 * 1024, '8m': 8 * 1024 * 1024, '32m': 32 * 1024 * 1024 };
const sizeOf = (s) => BYTES[s] ?? Number(s);

function stats(ms) {
  const a = [...ms].sort((x, y) => x - y);
  const at = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  return { n: a.length, min: +a[0].toFixed(3), median: +at(0.5).toFixed(3), p90: +at(0.9).toFixed(3), max: +a[a.length - 1].toFixed(3) };
}

// The source under measurement, plus whatever has to be torn down with it.
// NO MACHINE DEFAULTS on the docker arm: both inputs are required and refused
// by name when unset, so the arm cannot silently measure someone else's box.
const DOCKER_LAUNCH = (opt('--provider-argv', process.env.CC_FUSE_BENCH_PROVIDER_ARGV ?? '') || '').split(' ').filter(Boolean);
const DOCKER_REMOTE = opt('--remote', process.env.CC_FUSE_BENCH_REMOTE ?? '');
const DOCKER_ROOT = opt('--box-root', '/root/cc-bench');

async function makeArm(arm, root, log) {
  if (arm === 'localdir') return { source: localDirSource(root), dispose: () => {} };
  if (arm === 'docker') {
    if (!DOCKER_LAUNCH.length) {
      throw new Error('--arm docker needs --provider-argv (or CC_FUSE_BENCH_PROVIDER_ARGV): the argv of the System provider to launch, space-separated. There is no default — a baked-in launcher path measures one machine and says so nowhere.');
    }
    if (!DOCKER_REMOTE) {
      throw new Error('--arm docker needs --remote (or CC_FUSE_BENCH_REMOTE): the remote handle name to bind on that provider. There is no default — a baked-in container name measures one machine and says so nowhere.');
    }
    const owner = new ProviderSystem({ id: 'docker', launch: { argv: DOCKER_LAUNCH } });
    const sys = owner.bindRemote(DOCKER_REMOTE);
    await owner.connect();
    return { source: systemSource(sys), sys, dispose: () => owner.dispose() };
  }
  const launch = log
    ? ['node', RECORDER, '--log', log, '--', 'node', REFERENCE_PROVIDER]
    : ['node', REFERENCE_PROVIDER];
  const sys = new ProviderSystem({ id: 'bench', launch: { argv: launch } });
  await sys.connect();
  return { source: systemSource(sys), sys, dispose: () => sys.dispose() };
}

// One request, one reply, on a live socket.
function call(sock, op, flags, p) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (fn, v) => {
      sock.off('data', onData); sock.off('error', onErr); sock.off('close', onEnd);
      fn(v);
    };
    const onErr = (e) => done(reject, e);
    const onEnd = () => done(reject, new Error('the control socket closed with no reply'));
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < CCU_REPLY_LEN) return;
      done(resolve, buf[4]);
    };
    sock.on('data', onData); sock.on('error', onErr); sock.on('close', onEnd);
    sock.write(encodeRequest(op, flags, p));
  });
}

// cc → provider frame counts, or null when the recorder is not in line.
async function frameCounts() {
  if (!LOG) return null;
  const out = {};
  let text;
  try { text = await fs.readFile(LOG, 'utf8'); } catch { return {}; }
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [, dir, type] = line.split('\t');
    if (dir === 'c2p') out[type] = (out[type] ?? 0) + 1;
  }
  return out;
}

const frameDelta = (a, b) => (a && b
  ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])]
    .map(k => [k, (b[k] ?? 0) - (a[k] ?? 0)]).filter(([, v]) => v))
  : null);

async function rig(fn, { log = LOG } = {}) {
  const box = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-bench-'));
  const root = await fs.realpath(box);
  // `localDirSource` addresses by the path the WORKER sees and joins it under
  // its root; `systemSource` takes the path as-is. Putting the tree at the SAME
  // absolute path under both roots is what makes one path string work for both,
  // so the two arms drive byte-identical frames.
  // THE DOCKER ARM'S TREE IS ON THE BOX, because there is no shared filesystem
  // to build it on — which is the whole difference the arm exists to measure.
  const remote = ARM === 'docker';
  const src = remote ? path.posix.join(DOCKER_ROOT, path.basename(root)) : path.join(root, 'src');
  const mirror = path.join(root, 'mirror');
  if (!remote) await fs.mkdir(src, { recursive: true });
  await fs.mkdir(mirror, { recursive: true });
  const arm = await makeArm(ARM, ARM === 'localdir' ? '/' : root, log);
  // Written through the arm's OWN handle, so one call site serves every arm.
  const put = async (p, bytes) => (remote
    ? arm.sys.writeFileBytes(p, bytes, { atomic: true })
    : fs.writeFile(p, bytes));
  const mkdirp = async (p) => (remote ? arm.sys.mkdir(p, { recursive: true }) : fs.mkdir(p, { recursive: true }));
  if (remote) await mkdirp(src);
  const server = await ControlServer.listen({
    socketPath: path.join(root, 'control.sock'),
    mirror,
    source: arm.source,
    tiers: buildTierTable(tierFixtureInput({ systemPath: src, mirrorRoot: src })),
  });
  const sock = await new Promise((res, rej) => {
    const c = net.connect(server.socketPath, () => res(c)); c.once('error', rej);
  });
  try { return await fn({ root, src, mirror, sock, sys: arm.sys, put, mkdirp }); }
  finally {
    sock.destroy();
    await server.close();
    if (remote) await arm.sys.removeTree(src).catch(() => {});
    arm.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const row = (label, s) => console.log(
  `${CASE}\t${ARM}\t${label}\tn=${s.n}\tmedian=${s.median}ms\tp90=${s.p90}ms\tmin=${s.min}\tmax=${s.max}`);

// M1 — the COLD per-open pull. A fresh path per run, so nothing is warm and
// nothing is deduplicated by the fingerprint.
async function fetchCold() {
  for (const label of SIZES) {
    const bytes = Buffer.alloc(sizeOf(label), 0x61);
    await rig(async ({ src, sock, put }) => {
      const ms = [];
      for (let i = 0; i < RUNS; i++) {
        const p = path.posix.join(src, `cold-${label}-${i}`);
        await put(p, bytes);
        const t = performance.now();
        const status = await call(sock, CCU_OP.FETCH, 0, p);
        ms.push(performance.now() - t);
        if (status !== CCU_STATUS.READY) throw new Error(`FETCH ${p} → status ${status}`);
      }
      row(label, stats(ms));
      await countOne(label, () => call(sock, CCU_OP.FETCH, 0, path.posix.join(src, `counted-${label}`)),
        () => put(path.posix.join(src, `counted-${label}`), bytes));
    });
  }
}

// ONE OBSERVED iteration's cc → provider frames, printed beside the timings.
// A count derived by arithmetic is not a measurement, which is the whole
// reason this instrument exists.
async function countOne(label, once, setup) {
  if (!LOG) return;
  await setup?.();
  const before = await frameCounts();
  await once();
  console.log(`${CASE}\t${ARM}\t${label}\tframes=${JSON.stringify(frameDelta(before, await frameCounts()))}`);
}

// M2 — the WARM per-open revalidate. ONE path, opened RUNS+1 times; the first
// open is discarded because it is M1's measurement, not this one's.
async function fetchWarm() {
  for (const label of SIZES) {
    const bytes = Buffer.alloc(sizeOf(label), 0x61);
    await rig(async ({ src, sock, put }) => {
      const p = path.posix.join(src, `warm-${label}`);
      await put(p, bytes);
      await call(sock, CCU_OP.FETCH, 0, p);
      const ms = [];
      for (let i = 0; i < RUNS; i++) {
        const t = performance.now();
        const status = await call(sock, CCU_OP.FETCH, 0, p);
        ms.push(performance.now() - t);
        if (status !== CCU_STATUS.READY) throw new Error(`FETCH ${p} → status ${status}`);
      }
      row(label, stats(ms));
      await countOne(label, () => call(sock, CCU_OP.FETCH, 0, p));
    });
  }
}

// M4 — the listing collapse. `one-call` is what ships; `per-child` is the
// BEFORE picture and lives HERE ONLY, never in the product, so the comparison
// is against a real 1 + N and not against a remembered one.
async function list() {
  for (const n of CHILDREN) {
    await rig(async ({ src, sock, sys, put, mkdirp }) => {
      const dir = path.posix.join(src, `dir-${n}`);
      await mkdirp(dir);
      for (let i = 0; i < n; i++) await put(path.posix.join(dir, `f${i}`), Buffer.from('x'));
      if (SHAPE === 'per-child' && !sys) throw new Error('--shape per-child needs --arm reference');
      const once = async () => {
        if (SHAPE === 'per-child') {
          // The shape `readDir` had before the widening: name and kind from the
          // listing, everything else a round trip PER CHILD.
          const kids = await sys.readDir(dir);
          for (const k of kids) await sys.lstat(path.posix.join(dir, k.name));
          return;
        }
        const status = await call(sock, CCU_OP.LIST, 0, dir);
        if (status !== CCU_STATUS.READY) throw new Error(`LIST ${dir} → status ${status}`);
      };
      // Three warm-ups, discarded: the first LIST of a directory also SHAPES
      // every child into the mirror, which is a one-off cost this is not about.
      for (let i = 0; i < 3; i++) await once();
      // ONE OBSERVED iteration's frames. The `per-child` shape exists only in
      // this file, so its 1 + N is otherwise a count by ARITHMETIC rather than
      // by measurement — and an unobserved count is the thing this whole
      // instrument exists not to report.
      const fBefore = await frameCounts();
      await once();
      const f = frameDelta(fBefore, await frameCounts());
      if (f) console.log(`${CASE}\t${ARM}\t${SHAPE}/${n}\tframes=${JSON.stringify(f)}`);
      const ms = [];
      for (let i = 0; i < RUNS; i++) {
        const t = performance.now();
        await once();
        ms.push(performance.now() - t);
      }
      row(`${SHAPE}/${n}`, stats(ms));
    });
  }
}

// M3 — THE DOUBLE RECONCILE'S SECOND COPY. One written file's close sequence:
// the `flush` that lands the bytes, then the `release` that drops the claim.
//
// `--release-only off` IS A BENCH-ONLY SWITCH AND NEVER A PRODUCT KNOB. It
// sends the release as a flags-0 DIRTY — the shape `pt_release` sent before
// CCU_FLAG_RELEASE_ONLY existed — so the before-picture is DRIVEN here rather
// than remembered. It is exactly the frame a handle whose `flush` never ran
// still sends, which is why the product can keep the backstop and lose the
// duplicate at the same time.
async function writeClose() {
  const releaseFlag = RELEASE_ONLY ? CCU_FLAG_RELEASE_ONLY : 0;
  for (const label of SIZES) {
    const bytes = Buffer.alloc(sizeOf(label), 0x61);
    await rig(async ({ src, mirror, sock, put }) => {
      // ONE CLOSE SEQUENCE on a fresh path: open-for-write, the worker's bytes
      // into the mirror, then flush + release. `put` seeds the SOURCE so the
      // open is an ordinary open of an existing file rather than a create.
      const once = async (i) => {
        const p = path.posix.join(src, `wc-${label}-${i}`);
        await put(p, bytes);
        if (await call(sock, CCU_OP.FETCH, CCU_FLAG_FOR_WRITE, p) !== CCU_STATUS.READY) {
          throw new Error(`FETCH ${p} refused`);
        }
        await fs.writeFile(path.join(mirror, p), bytes);
        const t = performance.now();
        if (await call(sock, CCU_OP.DIRTY, CCU_FLAG_FOR_WRITE, p) !== CCU_STATUS.READY) {
          throw new Error(`flush ${p} refused`);
        }
        if (await call(sock, CCU_OP.DIRTY, releaseFlag, p) !== CCU_STATUS.READY) {
          throw new Error(`release ${p} refused`);
        }
        return performance.now() - t;
      };
      await once('warm');
      const ms = [];
      for (let i = 0; i < RUNS; i++) ms.push(await once(i));
      row(`${label}/release-only=${RELEASE_ONLY ? 'on' : 'off'}`, stats(ms));
      // ONE OBSERVED close sequence's frames: `writeFile` 1 with the bit, 2
      // without. A count by arithmetic is not a measurement.
      if (LOG) {
        const before = await frameCounts();
        await once('counted');
        console.log(`${CASE}\t${ARM}\t${label}/release-only=${RELEASE_ONLY ? 'on' : 'off'}`
          + `\tframes=${JSON.stringify(frameDelta(before, await frameCounts()))}`);
      }
    });
  }
}

const CASES = { 'fetch-cold': fetchCold, 'fetch-warm': fetchWarm, list, 'write-close': writeClose };
const run = CASES[CASE];
if (!run) {
  console.error(`unknown --case ${CASE}; one of ${Object.keys(CASES).join(', ')}`);
  process.exit(2);
}
if (flag('--help')) { console.log('see the header'); process.exit(0); }
await run();
