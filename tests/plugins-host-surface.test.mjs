import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPluginHost, WORKSPACE_AUTO_ASSIGN } from '../src/plugins/registry.ts';

// Characterization pin for createPluginHost()'s PUBLIC SURFACE.
//
// The plugin host is the single service layer behind the REST api
// (src/plugins/api.ts), the reverse proxy (src/plugins/proxy.ts), the MCP
// server (src/mcp/server.ts) and four server.ts provider wirings — each of
// which pins a *subset* of it through a structural `…Like` interface. Nothing
// pinned the WHOLE set, so a member silently renamed or dropped by a refactor
// only failed at the one consumer that happened to name it.
//
// The expected list below is HAND-TYPED on purpose. Deriving it from the host
// at runtime (Object.keys compared against Object.keys) passes against any
// surface and pins nothing.
const PUBLIC_MEMBERS = [
  'claudePluginDirs',
  'conventions',
  'disable',
  'enable',
  'ensureStarted',
  'init',
  'list',
  'notices',
  'reportUpstreamFailure',
  'rescan',
  'restart',
  'roles',
  'runtimeInfo',
  'setActiveVersion',
  'setServerPort',
  'start',
  'status',
  'stop',
  'stopAll',
  'toolsFor',
];

test('createPluginHost() returns exactly the documented member set, all functions', () => {
  const host = createPluginHost();
  assert.deepEqual(Object.keys(host).sort(), PUBLIC_MEMBERS,
    'the plugin host surface changed — every consumer interface in api.ts / proxy.ts / library.ts / mcp/server.ts is pinned to it');
  for (const name of PUBLIC_MEMBERS) {
    assert.equal(typeof host[name], 'function', `${name} must stay a function, not degrade into a property`);
  }
});

// server.ts:21 imports this literal to seed the conductor's own project into
// the same workspace discovery auto-assigns to. It must keep resolving from
// this module.
test('WORKSPACE_AUTO_ASSIGN is exported from registry.ts and is CC-Dev', () => {
  assert.equal(WORKSPACE_AUTO_ASSIGN, 'CC-Dev');
});

// roles() is the one accessor that MUST stay synchronous and init-free:
// server.ts installs the provider (setPluginRolesProvider) BEFORE init(), and
// appSettings.getPluginRoles() calls it synchronously while resolving a
// role→backend binding at spawn time. An `await ensureInit()` added here would
// make every role resolution see a Promise instead of an array — and no other
// test would catch it, because they all call host.list() first.
test('roles() on a never-inited host is synchronous and returns []', () => {
  const host = createPluginHost();
  const out = host.roles();
  assert.equal(typeof out?.then, 'undefined', 'roles() must not return a Promise');
  assert.ok(Array.isArray(out));
  assert.deepEqual(out, []);
});

// notices() hands out a copy; the caller (GET /api/plugins) must not be able
// to mutate the host's own load-notice list.
test('notices() returns a fresh array each call', () => {
  const host = createPluginHost();
  const first = host.notices();
  assert.deepEqual(first, []);
  first.push({ file: 'bogus.json', reason: 'injected by the test', backup: null });
  assert.deepEqual(host.notices(), [], 'mutating a returned notices array must not reach the host');
});
