// The readiness rule for a spawned `server.ts` child — ONE definition, imported
// by every test that waits on one (tests/server-restart.test.mjs,
// tests/eaddrinuse-retry.test.mjs) and by the regression guard that proves the
// rule holds (tests/restart-port-identity.test.mjs). Reimplementing it per file
// would let a revert at a destructive call site slip past that guard.
//
// Readiness must come from OUR child, never from the port. A port picked by
// binding-and-freeing can be handed to another test file's `bootServer()`
// `listen(0)` before our child binds it, and a foreign server answers an HTTP
// readiness probe just as happily — after which a `POST /api/admin/restart`
// kills that other test process mid-run. The child prints this banner from the
// address it actually BOUND (`server.ts`), so the banner is proof of identity.
//
// TERMINATED with the newline `server.ts:228`'s `console.log` always emits:
// without it the needle is a prefix of every longer port's banner, so a wait
// for port 3000 would be satisfied by a child that bound 30001.
export const bannerFor = (port) => `code-conductor listening on http://127.0.0.1:${port}\n`;

// Resolves once `captured.stdout` holds the `nth` banner for `port`.
//
// The restart replacement is spawned `stdio:'inherit'` (src/restart.ts), so it
// writes into the same captured stdout as the process it replaced — hence
// `nth: 2` for a post-restart wait.
//
// Deadlines are generous by default: these tests boot the REAL server.ts (port
// bind + migrations + reconcile), which is CPU-starved under the concurrent
// suite. A wide deadline is free on the happy path and only widens the
// failure-detection window.
export async function waitForBanner(captured, port, { nth = 1, timeout = 20_000 } = {}) {
  const needle = bannerFor(port);
  const start = Date.now();
  for (;;) {
    if (captured.stdout.split(needle).length - 1 >= nth) return;
    if (Date.now() - start > timeout) {
      throw new Error(`child never printed listening banner #${nth} for port ${port}`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
}
