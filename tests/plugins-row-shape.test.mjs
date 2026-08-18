import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPluginHost } from '../src/plugins/registry.ts';
import { makePluginRoot } from './plugin-helpers.mjs';

// Characterization pin for the PluginRow view-model — the projection
// describeRow() builds, serialized verbatim by GET /api/plugins and consumed
// field-by-field by public/pluginManager.js and public/appSwitcher.js.
//
// Five of these fields (name, version, frontendPath, startedAt, crashTail) had
// no assertion anywhere in the suite against a real host row, yet
// pluginManager.js renders crashTail and appSwitcher.js renders
// `navLabel || name`. A field dropped by a refactor would ship as a blank UI
// panel with every test still green.
//
// HAND-TYPED on purpose — deriving the expectation from the row itself would
// pass against any shape.
const ROW_FIELDS = [
  'activeVersion',
  'conventions',
  'crashTail',
  'enabled',
  'errors',
  'frontendPath',
  'gitHead',
  'hasBackend',
  'hasFrontend',
  'hasMcp',
  'id',
  'manifestSource',
  'name',
  'navLabel',
  'pid',
  'port',
  'project',
  'roles',
  'stale',
  'startedAt',
  'state',
  'version',
];

test('a discovered (never-enabled) row carries the full PluginRow field set', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    const row = (await host.list()).find(r => r.id === 'fake-plugin');
    assert.ok(row, 'the fixture plugin is discovered');
    assert.equal(row.state, 'discovered');
    assert.deepEqual(Object.keys(row).sort(), ROW_FIELDS,
      'the PluginRow projection changed — public/pluginManager.js and public/appSwitcher.js read these by name');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('a running row carries the same field set, with the UI-read fields populated', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host.enable('fake-plugin');
    await host.ensureStarted('fake-plugin');
    const row = await host.status('fake-plugin');

    assert.deepEqual(Object.keys(row).sort(), ROW_FIELDS,
      'no field may appear or disappear with lifecycle state');

    // The five fields nothing else asserts on a real row, plus the healthy-state
    // crashTail contract pluginManager.js branches on.
    assert.equal(row.state, 'ready');
    assert.equal(row.name, 'Fake Plugin');
    assert.equal(row.version, '1.0.0');
    assert.equal(row.frontendPath, '/');
    assert.equal(row.navLabel, 'Fake');
    assert.equal(row.hasMcp, true);
    assert.equal(row.hasBackend, true);
    assert.equal(row.hasFrontend, true);
    assert.equal(typeof row.startedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(row.startedAt)), 'startedAt parses as a date');
    assert.ok(row.pid, 'pid is populated while running');
    assert.ok(row.port, 'port is populated while running');
    assert.equal(row.stale, false);
    assert.equal(row.crashTail, null, 'a healthy row reports no crash tail');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('crashTail carries the child output after a crash', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost({ _backoffUnitMs: 1 });
  try {
    await env.addPluginProject('crasher', {
      manifest: { id: 'crasher', name: 'Crasher', version: '1', pluginApi: 1, backend: { start: 'node crash.mjs' } },
    });
    await host.enable('crasher');
    await assert.rejects(host.ensureStarted('crasher'));

    const row = await host.status('crasher');
    assert.deepEqual(Object.keys(row).sort(), ROW_FIELDS);
    assert.equal(typeof row.crashTail, 'string');
    assert.match(row.crashTail, /boom/, 'the crash tail is what pluginManager.js renders in the failure panel');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});
