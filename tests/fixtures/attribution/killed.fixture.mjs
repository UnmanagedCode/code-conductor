// A file that never finishes, so the parent's FILE_KILL_MS watchdog SIGKILLs it.
//
// It exists to pin that a KILLED file still carries a duration and still appears in
// the slowest-files ranking. That is the one case where the diagnostic matters most
// — the ranking is how you find out which file got killed — and it is also the case
// with NO inner test completion at all, which is what makes it discriminating:
//   * source the duration from `test:summary` (the pre-fix runner) and there is no
//     event, because node emits a per-file summary only when the child EXITS;
//   * source it from the last INNER `test:complete` and there is no event either,
//     because the single test below never completes.
// Only the FILE-level `test:complete` fires for a killed file.
//
// Idle, not CPU-burning: the watchdog kills on child AGE, so there is no reason to
// spin a core (tests/fixtures/hang/busyloop.fixture.mjs already covers the
// never-yields-the-loop shape for the hang guard's own suite). A ref'd timer well
// past any deadline this test uses keeps the process alive and otherwise asleep.
import test from 'node:test';

test('killed fixture: never completes, so the watchdog must SIGKILL it', async () => {
  await new Promise(r => setTimeout(r, 600_000));
});
