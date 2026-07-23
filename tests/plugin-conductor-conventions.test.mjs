// A plugin's conductor conventions are ON by default while the plugin is
// enabled (derived from the live catalog); only the user's explicit off-switches
// persist (pluginOff). Exercises the real plugin host wired to the conduct
// catalog exactly as server.js does (the conductor-convention provider + a
// regen hook gated on hasConductorConventions), against a temp PROJECTS_ROOT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPluginHost } from '../src/plugins/registry.js';
import { createPluginLibrary } from '../src/plugins/library.js';
import {
  SEED_CONVENTIONS, getSelection, setSelection, composeCurrentConduct,
  setPluginConductorConventionsProvider,
} from '../src/conductorConventions.js';
import * as m0021 from '../migrations/0021-strip-plugin-slugs-from-conductor-conventions.mjs';
import { makePluginRoot, readFixtureManifest } from './plugin-helpers.mjs';

const conv = (slug, name) => ({ slug, name, description: 'd', file: 'conventions/sample.md', scope: 'conductor' });
const COND_PLUGIN = { id: 'cond-plugin', name: 'Cond Plugin', version: '1.0.0', pluginApi: 1, conventions: [conv('a', 'Conv A'), conv('b', 'Conv B')] };
const COND_ONE = { id: 'cond-plugin', name: 'Cond Plugin', version: '1.0.0', pluginApi: 1, conventions: [conv('a', 'Conv A')] };
const SEEDS = SEED_CONVENTIONS.map(m => m.slug);

async function writeManifest(dir, manifest) {
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(manifest, null, 2));
}

async function writeConductStore(root, store) {
  const file = path.join(root, '.code-conductor', 'conventions', 'conductor.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2) + '\n');
}

// Wire a host to the conduct catalog the same way server.js does: the
// conductor-convention provider + a regen hook gated on hasConductorConventions.
// `regen` counts how often CONDUCT.md WOULD regenerate (the real
// ensureConductProject is covered by conductor-conventions.test.mjs).
function wire(host) {
  const state = { regen: 0 };
  setPluginConductorConventionsProvider(async () => (await host.conventions()).conductor);
  host.setEnabledChangeHook(async (id) => {
    if (host.hasConductorConventions(id)) state.regen++;
  });
  return state;
}

test('enabling a plugin turns its conductor conventions on + composes them', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('condp', { manifest: COND_PLUGIN });
    const host = createPluginHost();
    const spy = wire(host);

    await host.enable('cond-plugin');

    const sel = await getSelection();
    assert.ok(sel.includes('cond-plugin/a'), 'convention a on');
    assert.ok(sel.includes('cond-plugin/b'), 'convention b on');
    assert.equal(spy.regen, 1, 'regeneration fired once');
    assert.match(await composeCurrentConduct(), /Visual UX verification/);
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

test('enabling a plugin with no conductor conventions leaves the selection untouched', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('fakep', { manifest: await readFixtureManifest() }); // backend, no conventions
    const host = createPluginHost();
    const spy = wire(host);

    await host.enable('fake-plugin');

    assert.deepEqual((await getSelection()).sort(), [...SEEDS].sort(), 'selection is the default seeds');
    assert.equal(spy.regen, 0, 'no regeneration for a plugin without conductor conventions');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

test('a manually-disabled convention is excluded and persists across disable→re-enable', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('condp', { manifest: COND_PLUGIN });
    const host = createPluginHost();
    wire(host);

    await host.enable('cond-plugin');
    await setSelection([...SEEDS, 'cond-plugin/a']); // uncheck b → recorded off
    assert.ok(!(await getSelection()).includes('cond-plugin/b'), 'b off immediately');

    await host.disable('cond-plugin');
    await host.enable('cond-plugin');

    const sel = await getSelection();
    assert.ok(sel.includes('cond-plugin/a'), 'a back on');
    assert.ok(!sel.includes('cond-plugin/b'), 'b stays off (manual-off remembered)');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

test('re-checking a plugin convention clears its manual-off record', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('condp', { manifest: COND_PLUGIN });
    const host = createPluginHost();
    wire(host);

    await host.enable('cond-plugin');
    await setSelection([...SEEDS, 'cond-plugin/a']);                    // b off
    await setSelection([...SEEDS, 'cond-plugin/a', 'cond-plugin/b']);   // b re-checked → clears off

    assert.ok((await getSelection()).includes('cond-plugin/b'), 'b on again after re-check');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

test('disabling a plugin drops its conventions via the catalog; compose resolves', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('condp', { manifest: COND_PLUGIN });
    const host = createPluginHost();
    wire(host);

    await host.enable('cond-plugin');
    await host.disable('cond-plugin');

    const sel = await getSelection();
    assert.ok(!sel.some(s => s.startsWith('cond-plugin/')), 'no plugin slugs remain');
    await assert.doesNotReject(composeCurrentConduct(), 'compose survives a disabled plugin');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

test('a plugin update that ADDS a convention turns it on with no toggle', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('condp', { manifest: COND_ONE }); // [a]
    const host = createPluginHost();
    wire(host);

    await host.enable('cond-plugin');
    let sel = await getSelection();
    assert.ok(sel.includes('cond-plugin/a') && !sel.includes('cond-plugin/b'), 'only a before update');

    await writeManifest(dir, COND_PLUGIN); // update adds b
    await host.rescan();

    sel = await getSelection();
    assert.ok(sel.includes('cond-plugin/a'), 'a still on');
    assert.ok(sel.includes('cond-plugin/b'), 'added convention b on by default, no toggle');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

test('a plugin update that REMOVES a convention drops it gracefully', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('condp', { manifest: COND_PLUGIN }); // [a, b]
    const host = createPluginHost();
    wire(host);

    await host.enable('cond-plugin');
    assert.ok((await getSelection()).includes('cond-plugin/b'), 'b on before update');

    await writeManifest(dir, COND_ONE); // update removes b
    await host.rescan();

    const sel = await getSelection();
    assert.ok(sel.includes('cond-plugin/a'), 'a still on');
    assert.ok(!sel.includes('cond-plugin/b'), 'removed convention b gone');
    await assert.doesNotReject(composeCurrentConduct(), 'compose resolves after removal');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

test('a manual off-switch survives an update that removes then re-adds the convention', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('condp', { manifest: COND_PLUGIN }); // [a, b]
    const host = createPluginHost();
    wire(host);

    await host.enable('cond-plugin');
    await setSelection([...SEEDS, 'cond-plugin/a']); // user unchecks b → pluginOff gets cond-plugin/b
    assert.ok(!(await getSelection()).includes('cond-plugin/b'), 'b off');

    await writeManifest(dir, COND_ONE);   // update REMOVES b
    await host.rescan();
    await writeManifest(dir, COND_PLUGIN); // update RE-ADDS b
    await host.rescan();

    const sel = await getSelection();
    assert.ok(sel.includes('cond-plugin/a'), 'a still on');
    assert.ok(!sel.includes('cond-plugin/b'), 're-added b stays off — manual off-switch persisted across update churn');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

test('installing a plugin enables it by default and activates its conventions', async () => {
  const env = await makePluginRoot();
  try {
    const host = createPluginHost();
    wire(host);
    // Fake clone: drop a conventions-only plugin (no backend ⇒ no lazy start)
    // at the derived project dir, with its fragment file present.
    const lib = createPluginLibrary({
      pluginHost: host,
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true });
        await writeManifest(destDir, {
          id: 'code-share', name: 'Code Share', version: '1.0.0', pluginApi: 1,
          conventions: [{ slug: 'a', name: 'Conv A', description: 'd', file: 'conv.md', scope: 'conductor' }],
        });
        await fs.writeFile(path.join(destDir, 'conv.md'), '## Installed convention\n- x');
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    await lib.install('code-share');

    const row = (await host.list()).find(r => r.id === 'code-share');
    assert.ok(row, 'plugin discovered');
    assert.equal(row.enabled, true, 'freshly installed plugin is enabled by default');
    assert.ok((await getSelection()).includes('code-share/a'), 'its conductor convention is active');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

// Two plugins whose ids share a prefix — disabling one must not affect the other.
const FOO = { id: 'foo', name: 'Foo', version: '1.0.0', pluginApi: 1, conventions: [conv('x', 'Foo X')] };
const FOOBAR = { id: 'foobar', name: 'Foobar', version: '1.0.0', pluginApi: 1, conventions: [conv('x', 'Foobar X')] };

test('disabling one plugin does not drop a prefix-sharing plugin\'s conventions', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('foop', { manifest: FOO });
    await env.addPluginProject('foobarp', { manifest: FOOBAR });
    const host = createPluginHost();
    wire(host);

    await host.enable('foo');
    await host.enable('foobar');
    await host.disable('foo');

    const sel = await getSelection();
    assert.ok(!sel.includes('foo/x'), 'foo/x gone');
    assert.ok(sel.includes('foobar/x'), 'foobar/x survives the foo disable');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});

test('migration strips a legacy plugin slug from enabled; the convention stays on', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('condp', { manifest: COND_PLUGIN });
    const host = createPluginHost();
    wire(host);
    await host.enable('cond-plugin'); // conventions available in the catalog

    // Legacy (main) shape: the manually-enabled plugin convention sits in `enabled`.
    await writeConductStore(env.root, { enabled: ['canonical-workflow', 'cond-plugin/a'], rules: [] });

    const res = await m0021.run({ root: env.root, log: () => {} });
    assert.equal(res.applied, true);
    assert.deepEqual(res.summary, { stripped: ['cond-plugin/a'] });

    const store = JSON.parse(await fs.readFile(path.join(env.root, '.code-conductor', 'conventions', 'conductor.json'), 'utf8'));
    assert.deepEqual(store.enabled, ['canonical-workflow'], 'plugin slug stripped, seed retained');
    assert.ok(!('pluginOff' in store) || !store.pluginOff.includes('cond-plugin/a'), 'not moved to pluginOff');

    // The convention is still effectively on (on-by-default for the enabled plugin).
    assert.ok((await getSelection()).includes('cond-plugin/a'), 'convention survives the upgrade');

    // Idempotent.
    assert.equal((await m0021.run({ root: env.root, log: () => {} })).applied, false, 'second run is a no-op');
  } finally {
    setPluginConductorConventionsProvider(null);
    await env.restore();
  }
});
