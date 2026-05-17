// Programmatic test runner — the node wrapper on this device hoists leading
// `--flags` into NODE_OPTIONS, which rejects `--test`, so we invoke the
// node:test runner via its public API instead.
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const stream = run({ files, concurrency: 1, timeout: 30_000 });
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
