// Exits 0 when node_modules in the current directory matches package-lock.json,
// 1 (naming the first offender) otherwise. The rule is src/depsDrift.ts's, the
// one cc's own restart and self-update use; an --omit=dev install reads as in
// sync because no dev package is on disk.
import { dependencyDrift } from '../src/depsDrift.ts';

const drift = dependencyDrift(process.cwd());
if (drift) {
  console.error(`node_modules is out of sync with package-lock.json: ${drift.reason}`);
  process.exit(1);
}
