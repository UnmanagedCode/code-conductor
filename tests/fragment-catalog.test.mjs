// Unit tests for the shared fragment-catalog helper: seed bodies loaded from
// .md fragments, custom-entry CRUD with statusCode errors, compose, and the
// sibling-state (readState/patchState) accessors that preserve `rules`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFragmentCatalog } from '../src/fragmentCatalog.ts';

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

// A rule written straight into the store JSON that bypassed addCustom's string
// validation (hand-edited store, foreign garbage). loadCustom must coerce
// non-string name/description to '' and non-string body to undefined — not pass
// the raw values through, where a numeric body would be string-concatenated into
// composed markdown and a null name would slip past re-validation as "valid".
// customSlugsOf is what lets the selection collaborator build "everything this
// scope knows, minus the off-switches" from the ONE readState() it already
// makes — no catalog resolution, so no seed fragment is re-read off disk per
// getSelection(). Two claims, and both matter: it agrees with the catalog's own
// custom entries, and it does no I/O (proved by handing it a literal state
// object for a store file that does not exist).
test('customSlugsOf projects custom slugs out of already-read state, with no I/O', async () => {
  const { dir, catalog } = await mkFixture();
  try {
    await catalog.addCustom({ slug: 'baz', name: 'Baz', description: 'd', body: '## Baz' });
    await catalog.addCustom({ slug: 'qux', name: 'Qux', description: 'd', body: '## Qux' });

    const state = await catalog.readState();
    assert.deepEqual(catalog.customSlugsOf(state), ['baz', 'qux']);
    // Agrees with the catalog's own notion of which entries are custom.
    assert.deepEqual(
      (await catalog.getCatalog()).filter(c => !c.builtin).map(c => c.slug),
      catalog.customSlugsOf(state),
    );

    // Pure: a state literal for a store that was never written still answers,
    // and the same normalisation loadCustom applies drops the junk rules.
    assert.deepEqual(catalog.customSlugsOf({}), []);
    assert.deepEqual(catalog.customSlugsOf({ rules: 'nope' }), []);
    assert.deepEqual(
      catalog.customSlugsOf({ rules: [{ slug: 'ok' }, null, { name: 'no slug' }, { slug: 7 }] }),
      ['ok'],
    );
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a malformed rule in the store JSON is coerced, not concatenated into markdown', async () => {
  const { dir, catalog } = await mkFixture();
  try {
    await fs.writeFile(path.join(dir, 'store.json'), JSON.stringify({
      rules: [{ slug: 'x', name: null, description: null, body: 42 }],
    }));

    const cat = await catalog.getCatalog();
    const x = cat.find(c => c.slug === 'x');
    assert.ok(x, 'the malformed rule still surfaces in the catalog');
    assert.equal(x.name, '', 'non-string name coerced to empty string');
    assert.equal(x.description, '', 'non-string description coerced to empty string');
    assert.equal(x.body, undefined, 'non-string body coerced to undefined — no markdown injected');
    assert.equal(x.builtin, false);

    // compose resolves the slug but the entry contributes no body — no '42'.
    assert.equal(await catalog.compose(['x']), '');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// composeWithMeta is the ONE implementation: compose() is its `.text`. The
// degraded half is lifted off the same getCatalog() the compose already makes,
// so it mirrors the catalog's own flag — the read the conductor role doc needs
// to tell an established absence from an unvouchable one (card 2026-0277).
//
// PINS: text equality with compose() for the same slugs (so nothing about the
// composed bytes moved), and `.degraded` equal to getCatalog().degraded across
// all three provider shapes — healthy, throwing, absent — INCLUDING for an
// empty slug list, which reports the catalog's real flag rather than a
// hardcoded false. That last one is the point: an empty list is itself
// something a degrade can CAUSE (every seed off, the only remaining slugs
// contributed by a plugin whose project just went unreachable), so a flag that
// short-circuits with the list is blind in exactly the arm that loses the most.
//
// The THIRD arm pins the other body-less return: an entry that resolves but
// carries no markdown (the scaffold-only convention shape) composes to '' too,
// and that return must report the flag just as the empty-list one does. A
// selection whose only entries are scaffold-only conventions is the reachable
// case — it composes '' during an outage, where a hardcoded false would say the
// emptiness was established.
//
// NOT CLAIMING: that compose() is IMPLEMENTED BY delegation — a duplicated but
// correct body is indistinguishable from here, and single-implementation is a
// property of the diff, not of the behaviour.
test('composeWithMeta returns compose()\'s exact text plus the catalog\'s degraded flag', async () => {
  const { dir } = await mkFixture();
  const seedDir = path.join(dir, 'seeds');
  const mk = (extraProvider) => createFragmentCatalog({
    seeds: [{ slug: 'foo', name: 'Foo', description: 'the foo' }],
    seedDir,
    storeFile: () => path.join(dir, `store-${Math.random().toString(36).slice(2)}.json`),
    noun: 'thing',
    extraProvider,
  });
  try {
    for (const [label, extraProvider] of [
      ['no provider at all', null],
      ['a healthy provider', async () => [{ slug: 'p/x', name: 'X', description: 'd', body: '## X' }]],
      ['a throwing provider', async () => { throw new Error('boom'); }],
    ]) {
      const catalog = mk(extraProvider);
      const meta = await catalog.composeWithMeta(['foo']);
      assert.equal(meta.text, await catalog.compose(['foo']), `${label}: text equals compose()`);
      assert.equal(meta.text, '\n## Foo\n- foo body\n', `${label}: and it is the same byte shape as ever`);
      assert.equal(meta.degraded, (await catalog.getCatalog()).degraded,
        `${label}: degraded mirrors the catalog's own flag`);
      // Both early returns carry the shape AND the flag, and the 400 still
      // fires from here.
      assert.deepEqual(await catalog.composeWithMeta([]),
        { text: '', degraded: (await catalog.getCatalog()).degraded },
        `${label}: an empty slug list reports the catalog's own flag, not a hardcoded false`);
      await expectStatus(() => catalog.composeWithMeta(['nope']), 400);
    }

    // A resolvable entry with NO body — the scaffold-only convention shape,
    // built the way the malformed-rule test above builds one: a store rule with
    // the key absent. Both directions, so neither a hardcoded true nor a
    // hardcoded false survives on this return.
    const bodyless = (name, extraProvider) => {
      const storeFile = path.join(dir, `${name}.json`);
      return { storeFile, catalog: createFragmentCatalog({ seeds: [], seedDir, storeFile: () => storeFile, noun: 'thing', extraProvider }) };
    };
    for (const [label, extraProvider, expected] of [
      ['a throwing provider', async () => { throw new Error('boom'); }, true],
      ['no provider at all', null, false],
    ]) {
      const { storeFile, catalog } = bodyless(`bodyless-${expected}`, extraProvider);
      await fs.writeFile(storeFile, JSON.stringify({ rules: [{ slug: 'scaffold-only', name: 'S', description: 'd' }] }));
      const meta = await catalog.composeWithMeta(['scaffold-only']);
      assert.equal(meta.text, '', `${label}: a body-less entry contributes no text`);
      assert.equal(meta.text, await catalog.compose(['scaffold-only']), `${label}: and compose() agrees`);
      assert.equal(meta.degraded, expected,
        `${label}: a body-less compose still reports the catalog's own flag`);
      assert.equal((await catalog.getCatalog()).degraded, expected, `${label}: which is the catalog's flag`);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
