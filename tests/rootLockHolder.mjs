// A projects-root lock contender in its own process, for tests/root-lock.test.mjs.
//
//   node tests/rootLockHolder.mjs <projectsRoot> [--busy-ms N] [--wait-go]
//
// Prints `HELD <gen>` and idles holding the lock, or prints `REFUSED <pid>` and
// exits 7. `--wait-go` prints `READY` once loaded and acquires only after a
// line on stdin, so a test can line several contenders up. `--busy-ms N` blocks
// the event loop for N ms after acquiring, printing `BUSY-UNTIL <epochMs>` first.
import path from 'node:path';
import { createInterface } from 'node:readline';
import { acquireRootLock, RootLockHeldError, ROOT_LOCK_HELD_EXIT } from '../src/rootLock.ts';
import { hostPlatform } from '../src/platform/index.ts';

const [root, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const busyIdx = rest.indexOf('--busy-ms');
const busyMs = busyIdx >= 0 ? Number(rest[busyIdx + 1]) : 0;

if (flag('--wait-go')) {
  process.stdout.write('READY\n');
  const rl = createInterface({ input: process.stdin });
  await new Promise((resolve) => rl.once('line', resolve));
  rl.close();
}

try {
  const lock = await acquireRootLock({ storeDir: path.join(root, '.code-conductor'), platform: hostPlatform });
  process.stdout.write(`HELD ${lock.gen}\n`);
  if (busyMs > 0) {
    const until = Date.now() + busyMs;
    process.stdout.write(`BUSY-UNTIL ${until}\n`);
    while (Date.now() < until) { /* starve the event loop */ }
  }
  setInterval(() => {}, 1 << 30);
} catch (e) {
  if (!(e instanceof RootLockHeldError)) throw e;
  process.stdout.write(`REFUSED ${e.holderPid}\n`);
  process.exit(ROOT_LOCK_HELD_EXIT);
}
