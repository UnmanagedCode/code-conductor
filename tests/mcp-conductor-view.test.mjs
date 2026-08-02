// The conductor-facing instance projection is an EXPLICIT ALLOWLIST, and the
// `list_instances` tool description must document exactly what it emits.
//
// The defect this guards: toConductorView used to be
// `({id, callerInstanceId, ...rest}) => rest`, so every field ever added to
// Instance.summary() was published to conductors automatically. That is how the
// misleading `sonnetWindow` reached list_instances / spawn_instance /
// wait_for_idle.summary / respawn_instance / promote_session while tools.js
// documented only 13 keys. The surface being UNDOCUMENTED was the bug — not its
// width — so the allowlist is close to parity and the tool description is
// pinned against it here rather than by review.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { CONDUCTOR_VIEW_KEYS } from '../src/mcp/handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_INSTANCE = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const TOOLS_SRC = path.join(__dirname, '..', 'src', 'mcp', 'tools.js');

let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_INSTANCE }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', name, params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  const raw = body.result.content[0].text;
  try { return JSON.parse(raw); }
  catch { assert.fail(`tools/call ${name} did not return JSON: ${raw}`); }
}

const sorted = (a) => a.slice().sort();

// Pull the documented key names out of the single `{…}` block in the
// list_instances description. Exported so the vacuity guard below can reuse it.
export function documentedKeys(toolsSource) {
  const at = toolsSource.indexOf("name: 'list_instances'");
  assert.ok(at >= 0, 'list_instances tool not found');
  const desc = toolsSource
    .slice(at, toolsSource.indexOf('inputSchema', at))
    // The description is built by JS string concatenation, so a key list can be
    // split across source lines as `…, ' +\n  'backend, …`. Rejoin before parsing.
    .replace(/['"]\s*\+\s*['"]/g, '');
  const brace = desc.match(/\{([^}]*)\}/);
  assert.ok(brace, 'the list_instances description must carry a {key, key, …} block');
  return brace[1].split(',').map(k => k.trim()).filter(Boolean);
}

test('the documented key list matches what toConductorView emits, one-for-one', async () => {
  const src = await fs.readFile(TOOLS_SRC, 'utf8');
  const documented = documentedKeys(src);
  // `hasIdleSubscriber` is appended downstream by listInstances, not by the
  // projection — so list_instances documents exactly the allowlist plus that.
  const expected = [...CONDUCTOR_VIEW_KEYS, 'hasIdleSubscriber'];

  // Non-vacuity: a regex that matched nothing would compare [] to [] under a
  // sloppier assertion. Pin the count first, then the contents.
  assert.ok(documented.length >= 20, `parsed only ${documented.length} keys — the description shape changed`);
  assert.equal(documented.length, 26);
  assert.equal(CONDUCTOR_VIEW_KEYS.length, 25);
  assert.deepEqual(sorted(documented), sorted(expected));
});

test('the doc-drift gate actually fails on a mangled description (vacuity guard)', () => {
  // Proves the parser can't silently succeed: if the {…} block loses a key, the
  // comparison above must notice. Run against a deliberately broken source.
  const mangled = `
    { name: 'list_instances',
      description: 'Each entry carries {project, sessionId}. blah',
      inputSchema: {} }`;
  const parsed = documentedKeys(mangled);
  assert.deepEqual(parsed, ['project', 'sessionId']);
  assert.notDeepEqual(sorted(parsed), sorted([...CONDUCTOR_VIEW_KEYS, 'hasIdleSubscriber']));
  // …and a description with no brace block is a hard error, not an empty pass.
  assert.throws(() => documentedKeys(`{ name: 'list_instances', description: 'no keys here', inputSchema: {} }`));
});

test('every conductor-facing projection emits exactly the allowlist', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });

  const spawned = await callTool('spawn_instance', {
    project: 'demo', mode: 'bypassPermissions', model: 'claude-haiku-4-5',
  });
  const sessionId = spawned.sessionId;
  assert.ok(sessionId);
  await waitFor(() => instances.liveForSession(sessionId)?.status === 'idle');

  // spawn_instance
  assert.deepEqual(sorted(Object.keys(spawned)), sorted(CONDUCTOR_VIEW_KEYS));

  // list_instances — the allowlist plus the downstream hasIdleSubscriber.
  const listed = await callTool('list_instances', {});
  const entry = (listed.instances ?? listed).find(i => i.sessionId === sessionId);
  assert.ok(entry, 'spawned worker must appear in list_instances');
  assert.deepEqual(sorted(Object.keys(entry)), sorted([...CONDUCTOR_VIEW_KEYS, 'hasIdleSubscriber']));

  // wait_for_idle.summary
  const waited = await callTool('wait_for_idle', { sessionId, timeoutMs: 5000 });
  assert.deepEqual(sorted(Object.keys(waited.summary)), sorted(CONDUCTOR_VIEW_KEYS));

  // promote_session — the spawned worker is temp by default on the MCP path.
  const promoted = await callTool('promote_session', { sessionId });
  assert.ok(!('ok' in promoted && promoted.ok === false), `promote refused: ${JSON.stringify(promoted)}`);
  assert.deepEqual(sorted(Object.keys(promoted)), sorted(CONDUCTOR_VIEW_KEYS));

});

test('every worker-summary handler routes through the single projection', async () => {
  // respawn_instance's success path needs a CRASHED-but-still-in-memory
  // instance, which this harness can't arrange cleanly (kill removes it, and a
  // live one is refused with SESSION_NOT_LIVE / "still running"). The four
  // lifecycle-verified call sites above plus this source-level check together
  // cover all five: nothing may hand-roll its own worker projection, because a
  // second projection is exactly how a field escapes the documented list.
  const src = await fs.readFile(path.join(__dirname, '..', 'src', 'mcp', 'handlers.js'), 'utf8');
  for (const fn of ['listInstances', 'spawnInstance', 'waitForIdle', 'respawnInstance', 'promoteSession']) {
    const at = src.indexOf(`export async function ${fn}(`);
    assert.ok(at >= 0, `handler ${fn} not found`);
    const body = src.slice(at, src.indexOf('\nexport ', at + 1));
    assert.ok(body.includes('toConductorView('), `${fn} must project through toConductorView`);
  }
  // …and there is exactly one definition of it.
  assert.equal(src.split('function toConductorView(').length - 1, 1);
});

test('the projection publishes contextWindowTokens and withholds sonnetWindow / instance ids', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo2' });
  const view = await callTool('spawn_instance', {
    project: 'demo2', mode: 'bypassPermissions', model: 'claude-haiku-4-5',
  });

  // The replacement field, as a real number resolved from {backend, model}.
  assert.equal(view.contextWindowTokens, 200_000);
  assert.equal(view.backend, 'claude');
  assert.equal(view.model, 'claude-haiku-4-5');

  // The removed field, and the per-process handles a conductor must never bind to.
  for (const gone of ['sonnetWindow', 'id', 'callerInstanceId', 'debugDir', 'autoApprovePlan', 'interrupting']) {
    assert.ok(!(gone in view), `${gone} must not reach the conductor view`);
  }
});

test('cwd is present and absolute — the conductor self-identification check reads it', async () => {
  // A conductor confirms its own cwd ends in `.conduct` and stops if it does not
  // (i.e. it is running inside a worker). A present-but-null cwd would silently
  // disable that check, so assert a usable value, not just the key.
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo3' });
  const view = await callTool('spawn_instance', {
    project: 'demo3', mode: 'bypassPermissions', model: 'claude-haiku-4-5',
  });
  assert.equal(typeof view.cwd, 'string');
  assert.ok(path.isAbsolute(view.cwd), `cwd must be absolute, got ${view.cwd}`);
  assert.ok(view.cwd.endsWith('demo3'));
});
