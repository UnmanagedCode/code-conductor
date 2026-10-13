// Exits 0 when node_modules in the current directory holds every runtime
// dependency package.json names, 1 (listing the missing ones) otherwise.
// Checks for node_modules/<dep>/package.json on disk: require.resolve cannot,
// since a package's `exports` may hide its package.json.
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const missing = Object.keys(pkg.dependencies ?? {})
  .filter((d) => !fs.existsSync(path.join('node_modules', d, 'package.json')));
if (missing.length) {
  console.error(`node_modules is missing: ${missing.join(', ')}`);
  process.exit(1);
}
