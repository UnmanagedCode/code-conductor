// ══ HOST-PIN ANCESTORS UNDER A WIDE MIRROR ROOT ═══════════════════════════
//
// At `mirrorRoot: '/'` every unpinned directory is `project` tier for the
// marked CLI, including each directory ABOVE a `host` pin. A real remote need
// not have those directories — a container whose image never held cc's
// projects root does not — and the marked CLI's recursive mkdir under its own
// config dir walks straight through them. These arms build that remote: the
// shared fixture's mirror source with the projects root's ancestors taken
// away, then the spawn and the CLI's own `mkdirSync(…, {recursive:true})`
// under `<PROJECTS_ROOT>/.code-conductor/claude-config`.
//
// THE CONTRACT: the walk reaches the pin, and no frame that would create an
// ancestor on the remote is sent. `fakeRemote` is writable by the push, so a
// frame that got through would leave a directory there — which is what a root
// exec user does to a real container — and a `0555` ancestor stands in for an
// exec user that cannot write it.
//
// The remote-PRESENT arm of the same rule is R14
// (tests/fuse-union-routing.real.test.mjs), whose fixture keeps the scaffold.
//
// Skipped by default — opt in with `RUN_FUSE_LIFECYCLE=1`, run with the family:
//
//   TEST_CONCURRENCY=1 RUN_FUSE_LIFECYCLE=1 node tests/run.mjs tests/fuse-*.real.test.mjs
//
// The dependency preflight, the server, the three systems, the mirror scaffold
// and the observation helpers live in ./fuseGateCase.mjs. This file has its own
// `fakeRemote`, so stripping it touches no other file's arms.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveTierEntry } from '../src/systems/fuse/tierTable.ts';
import {
  ENABLED, setupFuseGate, spawnWorker, snapshot, readRecord, assertNoResidue,
  ancestorsOf, inNs, inside, eventsOf,
} from './fuseGateCase.mjs';

let instances, box, runRoot, fakeRemote;

// A marked probe: node run THROUGH the union at `plan.markPath` marks its own
// thread group, so every op its script makes is the marked CLI's.
const markedNode = (inst, record, script, ...args) => inNs(record.anchorPid,
  'exec "$1" -e "$2" "$3"', inside(record, inst._fuse.plan.markPath), script, ...args);
const MKDIR_P = 'require("fs").mkdirSync(process.argv[1],{recursive:true})';
const READDIR = 'console.log(JSON.stringify(require("fs").readdirSync(process.argv[1]).sort()))';

describe('a worker inside a FUSE-union chroot: host-pin ancestors under a wide mirror root', { skip: !ENABLED }, () => {
  setupFuseGate('union-pin-ancestors', c => { ({ instances, box, runRoot, fakeRemote } = c); });

  // The shallowest ancestor of the projects root that is not also on the wide
  // project's own chain. Everything at or below it, down to the projects root,
  // is an ancestor of a host pin and of nothing the project needs.
  const topAncestor = () => {
    const chain = new Set([...ancestorsOf(path.join(box, 'wide', 'appw'))]);
    const top = ancestorsOf(process.env.PROJECTS_ROOT).find(a => !chain.has(a));
    assert.ok(top, `no ancestor of ${process.env.PROJECTS_ROOT} lies off the wide project's chain`);
    return top;
  };

  // Every `project`-tier strict ancestor of a host pin at or under `top` — the
  // set no remote frame may create and no deny row may name. A host pin's
  // ancestor that is itself host-pinned (the projects root, above the store) is
  // the host's and not in it. The projects root's parent must be, or the arm is
  // measuring a table that host-serves the chain.
  const hostPinAncestorsUnder = (inst, top) => {
    const out = new Set();
    for (const e of inst._redirect.tiers) {
      if (e.tier !== 'host') continue;
      for (const a of ancestorsOf(e.prefix))
        if ((a === top || a.startsWith(top + '/'))
            && resolveTierEntry(inst._redirect.tiers, a)?.tier === 'project') out.add(a);
    }
    for (const a of [top, path.dirname(process.env.PROJECTS_ROOT)])
      assert.ok(out.has(a), `${a} is not a project-tier host-pin ancestor here, so this arm `
        + `measures the wrong tier: ${JSON.stringify([...out])}`);
    return out;
  };

  const mkdirTarget = (leaf) =>
    path.join(process.env.PROJECTS_ROOT, '.code-conductor', 'claude-config', leaf);

  // P1 — only the top ancestor is on the remote, and it is read-only there.
  // INVARIANT: a pin ancestor the remote lacks is traversable to the marked CLI
  // and no create frame reaches the remote for it; one the remote has is
  // served as the remote's own node, its listing naming the remote's entries
  // merged with the pin's child.
  test('P1 — the remote has only the top ancestor, read-only: the spawn and the CLI’s recursive mkdir succeed, and the remote is untouched', async () => {
    const before = snapshot(runRoot);
    const top = topAncestor();
    const remoteTop = path.join(fakeRemote, top);
    await fs.rm(remoteTop, { recursive: true, force: true });
    await fs.mkdir(remoteTop, { recursive: true });
    await fs.writeFile(path.join(remoteTop, 'remote-sentinel.txt'), 'SYSTEM-SIDE\n');
    await fs.chmod(remoteTop, 0o555);
    let inst;
    try {
      inst = await spawnWorker('chroot', 'appw');
      const record = await readRecord(inst.id);
      const ancestors = hostPinAncestorsUnder(inst, top);

      const target = mkdirTarget('p1');
      const mk = await markedNode(inst, record, MKDIR_P, inside(record, target));
      assert.equal(mk.ok, true, `the marked recursive mkdir failed: ${mk.stdout} ${mk.stderr}`);
      assert.equal(await fs.stat(target).then(st => st.isDirectory(), () => false), true,
        `the marked mkdir reported success and ${target} is not a directory on the host`);

      assert.deepEqual(await fs.readdir(remoteTop), ['remote-sentinel.txt'],
        'the remote gained an entry under the top host-pin ancestor');

      // Where the remote HAS the ancestor it is the remote's node — the
      // mirror entry cc shaped, owned by cc's uid, at a real inode — and not
      // the synthetic one (uid 0, an inode at or past SYNTH_INO_BASE).
      const st = await markedNode(inst, record,
        'const s=require("fs").statSync(process.argv[1],{bigint:true});console.log(s.uid+" "+s.ino)',
        inside(record, top));
      assert.equal(st.ok, true, `the marked stat of ${top} failed: ${st.stderr}`);
      const [uid, ino] = st.stdout.trim().split(' ').map(BigInt);
      assert.ok(uid === BigInt(process.getuid()) && ino < 0x7000000000000000n,
        `${top} is not the remote's node (uid ${uid}, ino ${ino}) although the remote has it`);
      // …and its listing is the remote's entries merged with the pin
      // children: every name a tier prefix under `top` leads through, less the
      // ones `hide` or `fail` suppress.
      //
      // LISTED AT 0755, NOT 0555. A known gap: a child shaped into a mirror
      // directory without owner-write fails, because `#stat` gives the mirror
      // directory the remote's mode and cc's uid cannot then create the
      // children `#list` shapes into it, so the marked readdir of a read-only
      // remote directory answers EIO. The 0555 half above is the mkdir one.
      await fs.chmod(remoteTop, 0o755);
      const pinChildren = new Set();
      for (const e of inst._redirect.tiers) {
        const rel = path.relative(top, e.prefix);
        if (!rel || rel.startsWith('..')) continue;
        const child = path.join(top, rel.split('/')[0]);
        const tier = resolveTierEntry(inst._redirect.tiers, child)?.tier;
        if (tier !== 'hide' && tier !== 'fail') pinChildren.add(path.basename(child));
      }
      const pinChild = path.relative(top, process.env.PROJECTS_ROOT).split('/')[0];
      assert.ok(pinChildren.has(pinChild),
        `the derived pin children of ${top} do not include ${pinChild}: ${JSON.stringify([...pinChildren])}`);
      const want = [...new Set([...await fs.readdir(remoteTop), ...pinChildren])].sort();
      const ls = await markedNode(inst, record, READDIR, inside(record, top));
      assert.equal(ls.ok, true, `the marked readdir of ${top} failed: ${ls.stderr}`);
      assert.deepEqual(JSON.parse(ls.stdout.trim()), want,
        `the listing of ${top} is not the remote's entries merged with the pin children`);

      const denials = (await eventsOf(inst.id)).filter(r => r[0] === 'deny' && ancestors.has(r[2]));
      assert.deepEqual(denials, [], 'a deny row names a host-pin ancestor');
    } finally {
      await fs.chmod(remoteTop, 0o755).catch(() => {});
      if (inst) await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'P1');
  });

  // P2 — no ancestor below the shared chain is on the remote at all.
  // INVARIANT: with every host-pin ancestor absent the spawn and the marked
  // mkdir still succeed, and the remote gains no directory — the frame that
  // would litter a container as root is never sent.
  test('P2 — the remote has no host-pin ancestor: the spawn and the CLI’s recursive mkdir succeed, and nothing is created on the remote', async () => {
    const before = snapshot(runRoot);
    const top = topAncestor();
    const remoteTop = path.join(fakeRemote, top);
    await fs.chmod(remoteTop, 0o755).catch(() => {});
    await fs.rm(remoteTop, { recursive: true, force: true });
    let inst;
    try {
      inst = await spawnWorker('chroot', 'appw');
      const record = await readRecord(inst.id);
      const ancestors = hostPinAncestorsUnder(inst, top);

      const target = mkdirTarget('p2');
      const mk = await markedNode(inst, record, MKDIR_P, inside(record, target));
      assert.equal(mk.ok, true, `the marked recursive mkdir failed: ${mk.stdout} ${mk.stderr}`);
      assert.equal(await fs.stat(target).then(st => st.isDirectory(), () => false), true,
        `the marked mkdir reported success and ${target} is not a directory on the host`);

      assert.equal(await fs.stat(remoteTop).then(() => true, () => false), false,
        `the remote gained ${top}: a create frame for a host-pin ancestor reached it`);

      const denials = (await eventsOf(inst.id)).filter(r => r[0] === 'deny' && ancestors.has(r[2]));
      assert.deepEqual(denials, [], 'a deny row names a host-pin ancestor');
    } finally {
      if (inst) await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'P2');
  });
});
