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
//   --arm localdir   `localDirSource(<tmpdir>)`. THE CONTROL: S1's and S2's
//                    cost, and what every previous figure in this epic was.
//   --arm reference  `systemSource` over a ProviderSystem on the reference
//                    provider — the whole NDJSON → base64 → 64 KiB chunking
//                    path, deterministic and in-repo, which isolates the
//                    PROTOCOL's cost from a container's.
//
// MEDIAN AND p90, NEVER A MEAN: one GC pause skews a mean and says nothing
// about the distribution a worker actually meets.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ControlServer, encodeRequest, CCU_OP, CCU_STATUS, CCU_REPLY_LEN } from '../src/systems/fuse/control.ts';
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

const CASE = opt('--case', 'fetch-cold');
const ARM = opt('--arm', 'localdir');
const RUNS = Number(opt('--runs', '30'));
const SIZES = opt('--sizes', '1k,64k,1m').split(',');
const CHILDREN = opt('--children', '1,10,50,200').split(',').map(Number);
const SHAPE = opt('--shape', 'one-call');

const BYTES = { '1k': 1024, '64k': 64 * 1024, '1m': 1024 * 1024, '8m': 8 * 1024 * 1024, '32m': 32 * 1024 * 1024 };
const sizeOf = (s) => BYTES[s] ?? Number(s);

function stats(ms) {
  const a = [...ms].sort((x, y) => x - y);
  const at = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  return { n: a.length, min: +a[0].toFixed(3), median: +at(0.5).toFixed(3), p90: +at(0.9).toFixed(3), max: +a[a.length - 1].toFixed(3) };
}

// The source under measurement, plus whatever has to be torn down with it.
async function makeArm(arm, root, log) {
  if (arm === 'localdir') return { source: localDirSource(root), dispose: () => {} };
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

async function rig(fn, { log } = {}) {
  const box = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-bench-'));
  const root = await fs.realpath(box);
  // `localDirSource` addresses by the path the WORKER sees and joins it under
  // its root; `systemSource` takes the path as-is. Putting the tree at the SAME
  // absolute path under both roots is what makes one path string work for both,
  // so the two arms drive byte-identical frames.
  const src = path.join(root, 'src');
  const mirror = path.join(root, 'mirror');
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(mirror, { recursive: true });
  const arm = await makeArm(ARM, ARM === 'localdir' ? '/' : root, log);
  const server = await ControlServer.listen({
    socketPath: path.join(root, 'control.sock'),
    mirror,
    source: arm.source,
    tiers: buildTierTable(tierFixtureInput({ systemPath: src, mirrorRoot: src })),
  });
  const sock = await new Promise((res, rej) => {
    const c = net.connect(server.socketPath, () => res(c)); c.once('error', rej);
  });
  try { return await fn({ root, src, mirror, sock, sys: arm.sys }); }
  finally {
    sock.destroy();
    await server.close();
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
    await rig(async ({ src, sock }) => {
      const ms = [];
      for (let i = 0; i < RUNS; i++) {
        const p = path.join(src, `cold-${label}-${i}`);
        await fs.writeFile(p, bytes);
        const t = performance.now();
        const status = await call(sock, CCU_OP.FETCH, 0, p);
        ms.push(performance.now() - t);
        if (status !== CCU_STATUS.READY) throw new Error(`FETCH ${p} → status ${status}`);
      }
      row(label, stats(ms));
    });
  }
}

// M2 — the WARM per-open revalidate. ONE path, opened RUNS+1 times; the first
// open is discarded because it is M1's measurement, not this one's.
async function fetchWarm() {
  for (const label of SIZES) {
    const bytes = Buffer.alloc(sizeOf(label), 0x61);
    await rig(async ({ src, sock }) => {
      const p = path.join(src, `warm-${label}`);
      await fs.writeFile(p, bytes);
      await call(sock, CCU_OP.FETCH, 0, p);
      const ms = [];
      for (let i = 0; i < RUNS; i++) {
        const t = performance.now();
        const status = await call(sock, CCU_OP.FETCH, 0, p);
        ms.push(performance.now() - t);
        if (status !== CCU_STATUS.READY) throw new Error(`FETCH ${p} → status ${status}`);
      }
      row(label, stats(ms));
    });
  }
}

// M4 — the listing collapse. `one-call` is what ships; `per-child` is the
// BEFORE picture and lives HERE ONLY, never in the product, so the comparison
// is against a real 1 + N and not against a remembered one.
async function list() {
  for (const n of CHILDREN) {
    await rig(async ({ src, sock, sys }) => {
      const dir = path.join(src, `dir-${n}`);
      await fs.mkdir(dir, { recursive: true });
      for (let i = 0; i < n; i++) await fs.writeFile(path.join(dir, `f${i}`), 'x');
      if (SHAPE === 'per-child' && !sys) throw new Error('--shape per-child needs --arm reference');
      const once = async () => {
        if (SHAPE === 'per-child') {
          // The shape `readDir` had before the widening: name and kind from the
          // listing, everything else a round trip PER CHILD.
          const kids = await sys.readDir(dir);
          for (const k of kids) await sys.lstat(path.join(dir, k.name));
          return;
        }
        const status = await call(sock, CCU_OP.LIST, 0, dir);
        if (status !== CCU_STATUS.READY) throw new Error(`LIST ${dir} → status ${status}`);
      };
      // Three warm-ups, discarded: the first LIST of a directory also SHAPES
      // every child into the mirror, which is a one-off cost this is not about.
      for (let i = 0; i < 3; i++) await once();
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

const CASES = { 'fetch-cold': fetchCold, 'fetch-warm': fetchWarm, list };
const run = CASES[CASE];
if (!run) {
  console.error(`unknown --case ${CASE}; one of ${Object.keys(CASES).join(', ')}`);
  process.exit(2);
}
if (flag('--help')) { console.log('see the header'); process.exit(0); }
await run();
