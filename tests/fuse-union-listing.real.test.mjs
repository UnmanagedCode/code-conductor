// ══ WHAT A MARKED LISTING OF A REMOTE DIRECTORY NAMES ════════════════════
//
// A marked `readdir` of a project-tier directory is the one op that asks cc to
// shape a directory's CHILDREN into the mirror (`LIST` → `#list`); every other
// op shapes one entry. The kernel issues a GETATTR (`STAT`) at the same path
// from the same tgid immediately before every opendir, so these arms list a
// directory nothing else has populated and compare the names against the
// remote's own — at the wide root and at the narrow default root.
//
// Skipped by default — opt in with `RUN_FUSE_LIFECYCLE=1`, run with the family:
//
//   TEST_CONCURRENCY=1 RUN_FUSE_LIFECYCLE=1 node tests/run.mjs tests/fuse-*.real.test.mjs
//
// The dependency preflight, the server, the three systems, the mirror scaffold
// and the observation helpers live in ./fuseGateCase.mjs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ENABLED, setupFuseGate, spawnWorker, snapshot, readRecord, assertNoResidue,
  inNs, inside,
} from './fuseGateCase.mjs';

let instances, box, runRoot, fakeRemote;

// A marked probe: node run THROUGH the union at `plan.markPath` marks its own
// thread group, so every op its script makes is the marked CLI's.
const markedNode = (inst, record, script, ...args) => inNs(record.anchorPid,
  'exec "$1" -e "$2" "$3"', inside(record, inst._fuse.plan.markPath), script, ...args);
const READDIR = 'console.log(JSON.stringify(require("fs").readdirSync(process.argv[1]).sort()))';

// The remote's own names at `p`, non-empty so an empty listing cannot pass by
// matching an empty remote.
const remoteNames = async (p) => {
  const names = (await fs.readdir(path.join(fakeRemote, p))).sort();
  assert.ok(names.length > 0, `the remote's ${p} is empty, so a listing of it proves nothing`);
  return names;
};

describe('a worker inside a FUSE-union chroot: what a marked listing of a remote directory names', { skip: !ENABLED }, () => {
  setupFuseGate('union-listing', c => { ({ instances, box, runRoot, fakeRemote } = c); });

  // L1 — the wide root (`mirrorRoot: '/'`).
  // INVARIANT: a marked listing of a remote project directory, root and
  // subdir, names exactly the remote's entries, and a local create shows
  // alongside them in the next listing.
  //
  // The create step does not discriminate whether the create cleared the
  // cached LIST answer: `pt_create` writes the mirror and `pt_readdir` reads
  // the mirror, so a stale cached LIST still lists the new file and only the
  // frame is skipped. `b54` in tests/fuse-union-policy.test.mjs pins that.
  test('L1 — wide root: a marked listing of the project root and of its .git names the remote’s entries, and a local create joins them', async () => {
    const before = snapshot(runRoot);
    const proj = path.join(box, 'wide', 'appw');
    const created = path.join(fakeRemote, proj, 'listing-new.txt');
    let inst;
    try {
      const wantRoot = await remoteNames(proj);
      const wantGit = await remoteNames(path.join(proj, '.git'));
      inst = await spawnWorker('chroot', 'appw');
      const record = await readRecord(inst.id);

      // ONE process, so every step is one tgid inside its own TTL — the
      // shape a real `ls` after a `stat` has.
      const script = 'const fs=require("fs"),p=require("path"),d=process.argv[1];'
        + 'const root=fs.readdirSync(d).sort();'
        + 'const git=fs.readdirSync(p.join(d,".git")).sort();'
        + 'fs.writeFileSync(p.join(d,"listing-new.txt"),"WORKER-CREATED\\n");'
        + 'const after=fs.readdirSync(d).sort();'
        + 'console.log(JSON.stringify({root,git,after}))';
      const r = await markedNode(inst, record, script, inside(record, proj));
      assert.equal(r.ok, true, `the marked listing probe failed: ${r.stdout} ${r.stderr}`);
      const { root, git, after } = JSON.parse(r.stdout.trim());

      assert.deepEqual(root, wantRoot, `the marked listing of ${proj} is not the remote's`);
      assert.deepEqual(git, wantGit, `the marked listing of ${proj}/.git is not the remote's`);
      assert.deepEqual(after, [...new Set([...wantRoot, 'listing-new.txt'])].sort(),
        `after a local create the listing of ${proj} is not the remote's entries plus the new file`);
    } finally {
      if (inst) await instances.remove(inst.id);
      await fs.rm(created, { force: true });
    }
    assertNoResidue(before, runRoot, null, 'L1');
  });

  // L2 — the narrow default root (`mirrorRoot == systemPath`).
  // INVARIANT: at the production default geometry a marked listing of the
  // project root names exactly the remote's entries.
  test('L2 — narrow default root: a marked listing of the project root names the remote’s entries', async () => {
    const before = snapshot(runRoot);
    const proj = path.join(box, 'app');
    let inst;
    try {
      const want = await remoteNames(proj);
      inst = await spawnWorker('chroot', 'app');
      const record = await readRecord(inst.id);
      const ls = await markedNode(inst, record, READDIR, inside(record, proj));
      assert.equal(ls.ok, true, `the marked readdir of ${proj} failed: ${ls.stderr}`);
      assert.deepEqual(JSON.parse(ls.stdout.trim()), want,
        `the marked listing of ${proj} is not the remote's`);
    } finally {
      if (inst) await instances.remove(inst.id);
    }
    assertNoResidue(before, runRoot, null, 'L2');
  });
});
