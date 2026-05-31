// Programmatic test runner — the node wrapper on this device hoists leading
// `--flags` into NODE_OPTIONS, which rejects `--test`, so we invoke the
// node:test runner via its public API instead.
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Each test file runs in its own child process (node:test `isolation: 'process'`
// default), and the suite is already isolated: bootServer binds an ephemeral
// port (listen(0)) and mkdtemp's a unique home per server, so files don't
// contend over ports or paths. That lets us run multiple files concurrently.
// Default to half the cores (capped at 4) to leave headroom for each file's
// express+ws boot and the timing-sensitive waits (control-request 5s, waitFor
// 4s) that contention could otherwise trip. Override with TEST_CONCURRENCY
// (1 restores the old fully-serial behavior).
function resolveConcurrency() {
  const env = process.env.TEST_CONCURRENCY;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

async function discover() {
  const want = process.argv.slice(2);
  if (want.length > 0) {
    return want.map(a => path.isAbsolute(a) ? a : path.resolve(process.cwd(), a));
  }
  const entries = await fs.readdir(__dirname);
  return entries
    .filter(n => n.endsWith('.test.mjs'))
    .map(n => path.join(__dirname, n))
    .sort();
}

const files = await discover();
if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

const concurrency = resolveConcurrency();
const stream = run({ files, concurrency, timeout: 30_000 });
let failed = 0;
stream.on('test:fail', (data) => {
  // Skip the implicit top-level pass/fail summary entries; only count real failures.
  if (data.details?.type === 'suite') return;
  failed++;
});
const reporter = stream.compose(new spec());
reporter.pipe(process.stdout);
await new Promise((resolve) => reporter.on('end', resolve));
process.exit(failed === 0 ? 0 : 1);
