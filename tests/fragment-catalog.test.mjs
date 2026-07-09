// Unit tests for the shared fragment-catalog helper: seed bodies loaded from
// .md fragments, custom-entry CRUD with statusCode errors, compose, and the
// sibling-state (readState/patchState) accessors that preserve `rules`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFragmentCatalog } from '../src/fragmentCatalog.js';

async function mkFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fragcat-'));
  const seedDir = path.join(dir, 'seeds');
  await fs.mkdir(seedDir, { recursive: true });
  await fs.writeFile(path.join(seedDir, 'foo.md'), '## Foo\n- foo body\n');
  await fs.writeFile(path.join(seedDir, 'bar.md'), '## Bar\n- bar body\n');
  const catalog = createFragmentCatalog({
    seeds: [
      { slug: 'foo', name: 'Foo', description: 'the foo' },
      { slug: 'bar', name: 'Bar', description: 'the bar' },
    ],
    seedDir,
    storeFile: () => path.join(dir, 'store.json'),
    noun: 'thing',
  });
  return { dir, catalog };
}

async function expectStatus(fn, code) {
  await assert.rejects(fn, e => { assert.equal(e.statusCode, code); return true; });
}

test('getCatalog returns seeds with bodies loaded from .md fragments', async () => {
  const { dir, catalog } = await mkFixture();
  try {
    const cat = await catalog.getCatalog();
    assert.equal(cat.length, 2);
    assert.deepEqual(cat.map(c => c.slug), ['foo', 'bar']);
    for (const c of cat) assert.equal(c.builtin, true);
    assert.equal(cat[0].body, '## Foo\n- foo body'); // trailing whitespace trimmed
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('addCustom merges with builtin:false; duplicate slug → 409', async () => {
  const { dir, catalog } = await mkFixture();
  try {
    const added = await catalog.addCustom({ slug: 'baz', name: 'Baz', description: 'd', body: '## Baz' });
    assert.equal(added.builtin, false);
    const cat = await catalog.getCatalog();
    assert.equal(cat.length, 3);
    assert.equal(cat.find(c => c.slug === 'baz').builtin, false);
    // dup against a seed and against the custom both 409
    await expectStatus(() => catalog.addCustom({ slug: 'foo', name: 'X', description: 'd', body: 'b' }), 409);
    await expectStatus(() => catalog.addCustom({ slug: 'baz', name: 'X', description: 'd', body: 'b' }), 409);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('validation: bad slug/fields → 400', async () => {
  const { dir, catalog } = await mkFixture();
  try {
    await expectStatus(() => catalog.addCustom({ slug: 'Bad Slug', name: 'n', description: 'd', body: 'b' }), 400);
    await expectStatus(() => catalog.addCustom({ slug: 'ok', name: '', description: 'd', body: 'b' }), 400);
    await expectStatus(() => catalog.addCustom({ slug: 'ok', name: 'n', description: 'd', body: '  ' }), 400);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('update/delete a built-in seed → 400; missing custom → 404', async () => {
  const { dir, catalog } = await mkFixture();
  try {
    await expectStatus(() => catalog.updateCustom('foo', { name: 'X' }), 400);
    await expectStatus(() => catalog.deleteCustom('bar'), 400);
    await expectStatus(() => catalog.updateCustom('nope', { name: 'X' }), 404);
    await expectStatus(() => catalog.deleteCustom('nope'), 404);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('updateCustom edits a custom entry; deleteCustom removes it', async () => {
  const { dir, catalog } = await mkFixture();
  try {
    await catalog.addCustom({ slug: 'baz', name: 'Baz', description: 'd', body: '## Baz' });
    const upd = await catalog.updateCustom('baz', { name: 'Baz2', body: '## Baz2' });
    assert.equal(upd.name, 'Baz2');
    assert.equal(upd.body, '## Baz2');
    const del = await catalog.deleteCustom('baz');
    assert.deepEqual(del, { slug: 'baz' });
    assert.equal((await catalog.getCatalog()).length, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('compose joins bodies; empty → ""; unknown slug → 400', async () => {
  const { dir, catalog } = await mkFixture();
  try {
    assert.equal(await catalog.compose([]), '');
    const block = await catalog.compose(['foo', 'bar']);
    assert.equal(block, '\n## Foo\n- foo body\n\n## Bar\n- bar body\n');
    await expectStatus(() => catalog.compose(['nope']), 400);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('patchState preserves rules; saveCustom preserves sibling state', async () => {
  const { dir, catalog } = await mkFixture();
  try {
    await catalog.addCustom({ slug: 'baz', name: 'Baz', description: 'd', body: '## Baz' });
    await catalog.patchState({ enabled: ['foo', 'baz'] });
    // sibling key readable
    assert.deepEqual((await catalog.readState()).enabled, ['foo', 'baz']);
    // rules survived the patch
    assert.ok((await catalog.getCatalog()).some(c => c.slug === 'baz'));
    // a subsequent rule write preserves the sibling key
    await catalog.addCustom({ slug: 'qux', name: 'Qux', description: 'd', body: '## Qux' });
    assert.deepEqual((await catalog.readState()).enabled, ['foo', 'baz']);
    assert.equal((await catalog.getCatalog()).length, 4);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
