// A trivial test followed by a SLOW ROOT TEARDOWN.
//
// It exists to pin that the reported figure includes work done AFTER the last inner
// test finishes. Teardown is where leaked handles surface — a ref'd socket that
// survives `server.close()` cost a whole file's report on card 2026-0194 — so a
// figure that stopped at the last inner test would under-report exactly the phase
// worth watching.
//
// The discriminating input is the FILE-level vs INNER `test:complete` choice: the
// inner test completes ~1ms in, the file-level one only after this hook returns, so
// sourcing the duration from the last inner completion drops the whole ~900ms.
// (Both the pre-fix `test:summary` source and the file-level source include it,
// since node emits the summary at child exit — so unlike killed.fixture.mjs this
// one does not discriminate against the pre-fix runner.)
import test, { after } from 'node:test';

test('teardown fixture: the test itself is trivial', () => {});

// ~900ms: comfortably inside LEAK_GRACE_MS (15s), which Layer B arms at the FIRST
// root after() hook — i.e. before this one runs.
after(async () => {
  await new Promise(r => setTimeout(r, 900));
});
