// THE MINOR-REUSE ARM of the real-FUSE gate. Skipped by default — opt in with
// `RUN_FUSE_LIFECYCLE=1`.
//
//   TEST_CONCURRENCY=1 RUN_FUSE_LIFECYCLE=1 node tests/run.mjs tests/fuse-teardown-minor-reuse.real.test.mjs
//
// One of the tests/fuse-*.real.test.mjs files; the harness, the family-wide
// rules and the family list live in ./fuseGateCase.mjs.
//
// THE QUESTION: can one session's teardown abort ANOTHER session's live FUSE
// connection? Unmounting the union root destroys its superblock and frees its
// anon minor, which the kernel hands out lowest-free — so the next FUSE mount
// on the host very likely gets the same number. fusectl is one global
// superblock and lists every connection on the host, so a teardown that aborts
// "the recorded minor if fusectl lists it" after that unmount aborts whoever
// took the number over.
//
// THE REUSE IS FORCED, NOT WAITED FOR. Session A is torn down by a direct
// `runTeardown` call whose driver, the moment A's union-root unmount has
// RETURNED, starts session B and blocks until B's handshake says `mounted`.
// Blocking after the unmount (never before it) keeps the arm free of a
// deadlock and meaningful whichever side of the ownership check it runs on:
// a teardown that still aborts after the unmount finds B holding the minor; one
// that aborts only while its root is attached has already aborted, and B mounts
// into a host where nothing will touch it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, waitFor } from './helpers.mjs';
import { fuseRunDir } from '../src/systems/fuse/plan.ts';
import { runTeardown } from '../src/systems/fuse/session.ts';
import { realMountDriver } from '../src/systems/fuse/driver.ts';
import {
  ENABLED, setupFuseGate, spawnWorker, snapshot, readRecord, assertNoResidue, inNsRoot, TURN_TIMEOUT_MS,
} from './fuseGateCase.mjs';

let baseUrl, instances, runRoot;

// The free minor is lowest-free across the HOST, so another FUSE mount on a
// shared machine can take it between A's unmount and B's mount. That is a
// failure to force the reuse, named as such, never a pass.
const ATTEMPTS = 3;

const terminal = (inst) => inst.status === 'exited' || inst.status === 'crashed';
const exitText = (inst) => `instance ${inst.id} ${inst.status}`
  + (inst.lastExit ? ` — code=${inst.lastExit.code} signal=${inst.lastExit.signal} stderr: ${inst.lastExit.stderrTail}` : '');

describe('a FUSE teardown and another session that reused its minor', { skip: !ENABLED }, () => {
  setupFuseGate('minor-reuse', c => { ({ baseUrl, instances, runRoot } = c); });

  // PINS (T6): on a real kernel, a session that took over a torn-down
  // session's connection minor survives that teardown.
  test('a session that reused a torn-down session\'s minor survives the teardown', async () => {
    const pairs = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const before = snapshot(runRoot);
      const instA = await spawnWorker();
      const recA = await readRecord(instA.id);
      assert.ok(recA, 'A wrote no mount.json handshake');

      // cc's own handle on A is dropped, so the only teardown A gets is the
      // one this arm drives — the same detach arm 4 of fuse-lifecycle.real
      // makes, short of the restart shutdown that would take B with it.
      await instA._fuse.controlServer?.close();
      instA._fuse = null;

      let instB = null, recB = null, rootUnmounts = 0, causeB;
      const driverErrors = [];
      const driver = {
        ...realMountDriver,
        async umountIn(nsPid, mp, opts) {
          const ok = await realMountDriver.umountIn(nsPid, mp, opts);
          if (!ok || mp !== recA.root || rootUnmounts++ > 0) return ok;
          // A thrown error would be contained by runTeardown into a wedge, so
          // it is carried out and rethrown after the call returns.
          try {
            const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app', mode: 'bypassPermissions' });
            assert.equal(r.status, 201, JSON.stringify(r.body));
            instB = instances.get(r.body.id);
            instB.on('exit_cause', (c) => { causeB = c; });
            recB = await waitFor(async () => {
              const rec = await readRecord(instB.id);
              return rec?.stage === 'mounted' ? rec : (terminal(instB) ? 'gone' : null);
            }, { timeout: TURN_TIMEOUT_MS });
            if (recB === 'gone') throw new Error(`B never mounted: ${exitText(instB)}`);
          } catch (e) { driverErrors.push(e); }
          return ok;
        },
      };

      const report = await runTeardown({ rundir: fuseRunDir(instA.id), driver, log: { warn() {} } });
      if (driverErrors.length) throw driverErrors[0];
      assert.equal(rootUnmounts, 1, `A's teardown never unmounted its union root: ${JSON.stringify(report)}`);
      assert.ok(instB && recB, 'B was never started');
      console.log(`fuse gate [minor-reuse] attempt ${attempt}: A minor=${recA.minor} abort=${report.abort}`
        + `, B minor=${recB.minor}, unmounted ${report.unmounted.length}`);
      assertNoResidue(before, runRoot, recA, `minor-reuse A (attempt ${attempt})`);

      if (recB.minor !== recA.minor) {
        pairs.push(`A=${recA.minor}, B=${recB.minor}`);
        await instances.remove(instB.id);
        await instances.remove(instA.id);
        continue;
      }

      // B reaches idle and completes a turn — the spawnWorker barrier — or
      // stops on the first terminal status with the cause in the message.
      await waitFor(() => instB.status === 'idle' || terminal(instB), { timeout: TURN_TIMEOUT_MS });
      assert.equal(terminal(instB), false, `B died after A's teardown: ${exitText(instB)}`);
      const seqOf = () => instB.ringSnapshot().filter(e => e.kind === 'turn_end').at(-1)?._seq ?? -1;
      const turnBefore = seqOf();
      await instB.prompt('hello');
      await waitFor(() => seqOf() > turnBefore || terminal(instB), { timeout: TURN_TIMEOUT_MS });
      assert.equal(terminal(instB), false, `B died after A's teardown: ${exitText(instB)}`);
      assert.equal(causeB, undefined, `B's exit_cause fired: ${JSON.stringify(causeB)}`);

      // B's connection is still live: its fusectl `waiting` is readable.
      const probe = await inNsRoot(recB.anchorPid, 'cat "$1/$2/waiting"', recB.fusectl, recB.minor);
      assert.ok(probe.ok, `B's connection ${recB.minor} is gone: ${probe.stderr}`);

      await instances.remove(instB.id);
      await instances.remove(instA.id);
      return;
    }
    assert.fail(`minor reuse not forced (${pairs.join('; ')}) in ${ATTEMPTS} attempts`);
  });
});
