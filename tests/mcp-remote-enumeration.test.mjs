// `enumerate_remotes` end to end: the MCP tool over cc's one enumeration caller
// (src/systems/remoteEnumeration.ts), rendered as plain text.
//
// The rendering is the tool's ENTIRE result, so its text is pinned verbatim
// against real providers — one block per System, in registry order, and the
// three states worded so that "not enumerable" and "failed" can never be read
// as "no remotes".

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { referenceLaunch } from './remoteSystem.mjs';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'remoteListFixtureProvider.mjs');

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

const LOCAL_BLOCK = "local · This machine\n  not enumerable — cc's own machine has no named remotes";
const LISTER_BLOCK = 'lister · Lister\n  enumerable — 2 remotes\n    ctr-a\n    ctr-b';
const PLAIN_BLOCK = "plain · Plain\n  not enumerable — system 'plain' does not advertise remoteListing — a remote is named by hand";
const BROKEN_BLOCK = 'broken · Broken\n  enumeration failed [EUNKNOWN] — fixture: configuration unreadable';

describe('enumerate_remotes', () => {
  let ctx, home;
  before(async () => { ctx = await bootServer(); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    const root = await fs.realpath(await mkdtemp('cc-remote-'));
    await addSystem({ id: 'lister', label: 'Lister', launch: referenceLaunch('--remote', `ctr-a=${root}`, '--remote', `ctr-b=${root}`) });
    await addSystem({ id: 'plain', label: 'Plain', launch: referenceLaunch() });
    await addSystem({ id: 'broken', label: 'Broken', launch: ['node', FIXTURE, '--advertise-listing', '--list-error', 'EUNKNOWN'] });
  });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // PINS THE TEXT OUTPUT: one text block and nothing else, one block per
  // System in registry order, and the three states each in their own words —
  // not enumerable and failed carry their reasons, never a list.
  test('renders one block per System as plain text', async () => {
    const r = await callTool(ctx.baseUrl, 'enumerate_remotes', {});
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].type, 'text');
    assert.equal(r.content[0].text,
      ['SYSTEMS (4)', LOCAL_BLOCK, LISTER_BLOCK, PLAIN_BLOCK, BROKEN_BLOCK].join('\n\n'));
  });

  // PINS the `system` argument: it names one registry id, and only that
  // System's block is rendered.
  test('a named system renders only its block', async () => {
    const r = await callTool(ctx.baseUrl, 'enumerate_remotes', { system: 'lister' });
    assert.equal(r.content[0].text, `SYSTEMS (1)\n\n${LISTER_BLOCK}`);
  });

  // PINS failure ≠ empty for a name nobody registered: a failed block naming
  // the registry's code, not an error result and not an empty listing.
  test('an unknown system renders a failed block', async () => {
    const r = await callTool(ctx.baseUrl, 'enumerate_remotes', { system: 'nosuch' });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.match(r.content[0].text,
      /^SYSTEMS \(1\)\n\nnosuch · nosuch\n {2}enumeration failed \[SYSTEM_NOT_REGISTERED\] — .*'nosuch'.*not in the system registry$/);
  });
});
