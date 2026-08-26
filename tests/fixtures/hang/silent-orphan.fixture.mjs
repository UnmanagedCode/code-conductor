// The orphan shape NO existing trigger can reach: one that wedges NOTHING.
//
// Every sibling here leaks a holder with `stdio: 'inherit'`, so it keeps the
// runner's own report pipe open and the STREAM STALL check finds it. That is the
// only reason those fixtures fail a run at all. This one is spawned with
// `stdio: 'ignore'`, which is the entire point: it holds no descriptor of ours,
// the report stream ends cleanly, the absolute cap is never approached, and
// before card 2026-0226 nothing looked at the end of a healthy run — so the run
// exited 0 and the process survived on the box forever. That is the measured
// production shape: a plugin child holds pipes to the TEST FILE's child, not to
// the runner, so it wedges nothing (21 such orphans were found across 9 runs
// whose run roots had all been removed, i.e. 9 runs that exited normally).
//
// `detached: true` additionally puts it in its own process group and its parent
// exits at once, so it is reparented to init and no lineage walk from the runner
// reaches it. The run marker in its environment is the only thing that still
// identifies it (processesWithMarker in tests/procTree.mjs).
import test from 'node:test';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';

// The holder SELF-TERMINATES — the same hygiene contract as
// detached-orphan.fixture.mjs: an immortal holder would leak one live process
// onto the box on every run of the case, which is this card's own failure class
// in this card's own fixture.
//
// The inequality this fixture's validity rests on is DIFFERENT from
// detached-orphan's. There the holder must outlive the STALL GRACE. Here nothing
// waits on the holder at all, so it must simply outlive the whole inner run —
// otherwise it dies before the run-end sweep looks and the case passes while
// proving nothing. HOLDER_LIFETIME (60s) is ~40x a healthy inner run.
const HOLDER_LIFETIME_MS = Number(process.env.CC_TEST_HOLDER_LIFETIME_MS ?? 60_000);

// Keeps the test BODY open, so the inner runner is still mid-run and signallable.
// 0 (the default) is the run-end case; the signal case sets it. It is a dwell in
// the body rather than a leaked timer so Layer B stays silent and the only thing
// this fixture ever leaks is the holder above.
const DWELL_MS = Number(process.env.CC_TEST_DWELL_MS ?? 0);

test('silent-orphan: leaks a live process that holds nothing of ours', async () => {
  const orphan = spawn(process.execPath,
    ['-e', `setTimeout(() => process.exit(0), ${HOLDER_LIFETIME_MS})`],
    { stdio: 'ignore', detached: true });
  orphan.unref();
  // fd 2 directly, not console.log: stderr is the one stream runGuard always
  // drains (stdout is deliberately stallable there), and a raw write cannot be
  // reformatted or buffered away by the reporter. The case reads this pid back
  // and asserts it is DEAD — `SWEPT` being printed is not proof of death.
  writeSync(2, `silent-orphan: holder pid=${orphan.pid}\n`);
  if (DWELL_MS > 0) await new Promise(r => setTimeout(r, DWELL_MS));
});
