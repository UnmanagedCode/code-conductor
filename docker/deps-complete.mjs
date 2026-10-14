// Exits 0 when node_modules in the current directory satisfies package.json,
// 1 (naming the first offender) otherwise. The rule is src/depsDrift.ts's, the
// one cc's own restart and self-update use; an --omit=dev install reads as in
// sync because no dev-only package is on disk.
import { dependencyDrift } from '../src/depsDrift.ts';

const drift = dependencyDrift(process.cwd());
if (drift) {
  console.error(`node_modules does not satisfy package.json: ${drift.reason}`);
  process.exit(1);
}
