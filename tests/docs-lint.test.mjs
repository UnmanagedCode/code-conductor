import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from './tmpRegistry.mjs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintDocs, formatFindings } from '../scripts/docs-lint.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Build a throwaway git repo from `files`, lint it, remove it. */
function lintFixture(files, allow = {}) {
  const dir = mkdtempSync('cc-docs-lint-');
  try {
    execFileSync('git', ['init', '-q', dir]);
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    execFileSync('git', ['-C', dir, 'add', '-A']);
    return lintDocs(dir, { allow });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const deadTexts = (r) => r.dead.map((d) => d.text).sort();

test('the real tree has no doc-lint findings', () => {
  const res = lintDocs(repoRoot);
  for (const [kind, list] of Object.entries(res)) {
    assert.deepEqual(list, [], `${kind}:\n${formatFindings({ [kind]: list }).join('\n')}`);
  }
});

test('a path span is dead when no tracked file or dir matches it', () => {
  const r = lintFixture({ 'src/real.ts': 'x', 'docs/a.md': '`src/real.ts` `src/gone.ts` `src/` `src/nope/`\n' });
  assert.deepEqual(deadTexts(r), ['src/gone.ts', 'src/nope/']);
});

test('a gitignored build output path is not dead', () => {
  const r = lintFixture({ '.gitignore': 'web/dist\n', 'docs/a.md': '`web/dist` `web/dist/x.js`\n' });
  assert.deepEqual(r.dead, []);
});

test('a migration number prefix resolves to its file', () => {
  const r = lintFixture({ 'migrations/0003-x.mjs': 'x', 'docs/a.md': '`migrations/0003` `migrations/0004`\n' });
  assert.deepEqual(deadTexts(r), ['migrations/0004']);
});

test('code-looking names are checked against non-doc files; plain words are not', () => {
  const r = lintFixture({
    'src/a.ts': 'const presentName = 1; const PRESENT_CONST = 2; const _hidden = 3;',
    'docs/a.md': '`presentName` `goneName` `PRESENT_CONST` `GONE_CONST` `_hidden` `_gone` `plainword` `Word` `x()`\n',
  });
  assert.deepEqual(deadTexts(r), ['GONE_CONST', '_gone', 'goneName']);
});

test('a dotted chain checks each code-like segment and strips a call suffix', () => {
  const r = lintFixture({
    'src/a.ts': 'class Thing { presentMethod() {} }',
    'docs/a.md': '`Thing.presentMethod()` `Thing.goneMethod(a, b)` `Thing.lower`\n',
  });
  assert.deepEqual(deadTexts(r), ['goneMethod']);
});

test('a bare filename is not checked', () => {
  const r = lintFixture({ 'docs/a.md': '`goneThing.test.tsx` `goneStore.json`\n' });
  assert.deepEqual(r.dead, []);
});

test('spans inside a fenced block are not checked', () => {
  const r = lintFixture({ 'docs/a.md': '```\n`goneName` `src/gone.ts`\n```\n~~~\n`goneName`\n~~~\n`goneOut`\n' });
  assert.deepEqual(deadTexts(r), ['goneOut']);
});

test('an allowlisted name is skipped; a resolving or unused entry is stale', () => {
  const files = { 'src/a.ts': 'const resolvingName = 1;', 'docs/a.md': '`externalName` `resolvingName`\n' };
  const r = lintFixture(files, { x: ['externalName', 'resolvingName', 'unusedName'] });
  assert.deepEqual(r.dead, []);
  assert.deepEqual(
    r.staleAllow.map((s) => [s.text, /resolves/.test(s.why) ? 'resolves' : 'unused']).sort(),
    [['resolvingName', 'resolves'], ['unusedName', 'unused']],
  );
});

test('an allowlisted path matches the whole span', () => {
  const r = lintFixture({ 'docs/a.md': '`src/absent.ts` `src/other.ts`\n' }, { x: ['src/absent.ts'] });
  assert.deepEqual(deadTexts(r), ['src/other.ts']);
  assert.deepEqual(r.staleAllow, []);
});

test('links resolve by file, heading slug (with duplicate suffix) and explicit anchor', () => {
  const r = lintFixture({
    'docs/a.md': '[1](other.md#missing) [2](other.md#h) [3](other.md#h-1) [4](other.md#named) [5](#self) [6](gone.md) [7](https://x.y/#z)\n\n# Self\n',
    'docs/other.md': '# H\n\n## H\n\n<a name="named"></a>\n',
  });
  assert.deepEqual(deadTexts(r), ['gone.md', 'other.md#missing']);
});

test('a link inside a code span is not checked', () => {
  const r = lintFixture({ 'docs/a.md': '`[x](gone.md)`\n' });
  assert.deepEqual(r.dead, []);
});

test('the line cap applies to prose; table rows are exempt only in ratcheted docs', () => {
  const row = `| ${'x'.repeat(2001)} |`;
  assert.equal(lintFixture({ 'docs/a.md': 'y'.repeat(2001) }).longLines.length, 1);
  assert.equal(lintFixture({ 'docs/a.md': 'y'.repeat(2000) }).longLines.length, 0);
  assert.equal(lintFixture({ 'docs/protocol.md': row }).longLines.length, 0);
  assert.equal(lintFixture({ 'docs/protocol.md': 'y'.repeat(2001) }).longLines.length, 1);
  assert.equal(lintFixture({ 'docs/other.md': row }).longLines.length, 1);
});

test('the byte cap is 100,000 by default and a ratchet for the named docs', () => {
  const lines = (n) => `${'z'.repeat(99)}\n`.repeat(Math.ceil(n / 100));
  assert.equal(lintFixture({ 'docs/a.md': lines(100100) }).overCap.length, 1);
  assert.equal(lintFixture({ 'docs/a.md': lines(99900) }).overCap.length, 0);
  assert.equal(lintFixture({ 'docs/features.md': lines(300000) }).overCap.length, 0);
  assert.equal(lintFixture({ 'docs/features.md': lines(500000) }).overCap.length, 1);
});

test('every components heading must be linked from the components index', () => {
  const r = lintFixture({
    'docs/components.md': '# Components\n\n- [`a`](components/x.md#a)\n',
    'docs/components/x.md': '# X\n\n## `a`\n\ntext\n\n## `b`\n\ntext\n\n### `c`\n',
  });
  assert.deepEqual(r.unindexed.map((u) => u.text), ['`b`']);
  assert.deepEqual(r.dead, []);
});
