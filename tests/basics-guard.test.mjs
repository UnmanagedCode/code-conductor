// Static scan: the dependency-free helpers live once, in shared/basics.ts.
// Pins: every helper that leaf exports has exactly one definition across src/
// and shared/ (plus the listed exemption), the folded alias names have none,
// and the leaf imports nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const LEAF = 'shared/basics.ts';
const LEAF_NAMES = ['errCode', 'errMsg', 'isRecord', 'asRecord', 'shQuote', 'sleep'];
// Same body under another name: must not be defined anywhere; use the canonical.
const ALIASES = { errText: 'errMsg', messageOf: 'errMsg', isJsonRecord: 'isRecord', isPlainObject: 'isRecord' };
const EXEMPT = [{
  file: 'src/systems/referenceProvider.ts', name: 'errMsg',
  why: 'copied flat into a container with only its siblings (PROVIDER_FILES in tests/systems-docker-boundary.real.test.mjs); its import closure must stay protocol.ts + ptyHost.ts',
}];
const defRe = (n) => new RegExp(`(?:\\bfunction\\s*\\*?\\s+${n}\\b|\\b(?:const|let|var)\\s+${n}\\s*[=:])`);

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...await walk(rel));
    else if (/\.(?:ts|tsx|mts|mjs|js|cjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const files = [...await walk('src'), ...await walk('shared')].sort();

// Code lines only: comment lines skipped.
async function codeLines(f) {
  return (await fs.readFile(path.join(root, f), 'utf8')).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

test('no src/ or shared/ module defines its own copy of a shared/basics.ts helper', async () => {
  const hits = [];
  for (const f of files) {
    if (f === LEAF) continue;
    const lines = await codeLines(f);
    const has = (n) => lines.some(l => defRe(n).test(l));
    for (const n of LEAF_NAMES) {
      if (EXEMPT.some(x => x.file === f && x.name === n)) continue;
      if (has(n)) hits.push(`${f}: ${n} (import it from ${LEAF})`);
    }
    for (const [alias, canon] of Object.entries(ALIASES)) {
      if (has(alias)) hits.push(`${f}: ${alias} (use ${canon} from ${LEAF})`);
    }
  }
  assert.deepEqual(hits, []);
});

test('shared/basics.ts defines each helper exactly once and imports nothing', async () => {
  const lines = await codeLines(LEAF);
  for (const n of LEAF_NAMES) {
    assert.equal(lines.filter(l => defRe(n).test(l)).length, 1, `${n} defined once in ${LEAF}`);
  }
  for (const a of Object.keys(ALIASES)) {
    assert.ok(!lines.some(l => defRe(a).test(l)), `${a} not defined in ${LEAF}`);
  }
  const src = await fs.readFile(path.join(root, LEAF), 'utf8');
  assert.doesNotMatch(src, /^\s*import\b|\bimport\s*\(|\brequire\s*\(|^\s*export\b[^;]*\bfrom\s*['"]/m);
});

test('every EXEMPT entry still holds a local definition (drop it when this reds)', async () => {
  for (const { file, name, why } of EXEMPT) {
    const lines = await codeLines(file);
    assert.ok(lines.some(l => defRe(name).test(l)), `${file} no longer defines ${name}; drop the exemption (${why})`);
  }
});
