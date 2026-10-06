// THE `remoteListing` FALLBACK: cc never sends `listRemotes` to a provider that
// does not advertise it (docs/systems-protocol.md §2, §2.2), and such a System
// is reported NOT ENUMERABLE — never as having no remotes.
//
// cc has one sender — `ProviderSystem.listRemotes`, reached through
// `enumerateSystemRemotes` (src/systems/remoteEnumeration.ts) — and two
// front-ends on it: `GET /api/systems/:id/remotes` and the MCP tool
// `enumerate_remotes`. A capability gate asserted from cc's side would pass
// whether or not the frame stayed home, so the evidence here is the bytes that
// crossed the pipe, recorded by tests/fixtures/recordingProvider.mjs, with every
// surface driven against the same recorder.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { addSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { enumerateAllRemotes, enumerateSystemRemotes } from '../src/systems/remoteEnumeration.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(__dirname, 'fixtures', 'recordingProvider.mjs');

async function wire(file) {
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

describe('a provider that does not advertise remoteListing', () => {
  let ctx, home;
  before(async () => { ctx = await bootServer(); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { disposeSystemHandles(); await rmrf(home); });

  // PINS THE CAPABILITY GATE, on the wire, through every surface the sender
  // has: no `listRemotes` frame reaches a provider that did not advertise
  // `remoteListing`. AND PINS not-enumerable ≠ empty: each surface reports the
  // System as `not-enumerable`, and none of them carries a `remoteIds` list —
  // an empty one would read as "this provider is configured for nothing".
  test('no listRemotes frame reaches a provider that does not advertise remoteListing', async () => {
    const rec = path.join(await mkdtemp('cc-wire-'), 'frames.jsonl');
    await addSystem({ id: 'box', label: 'Box', launch: ['node', RECORDER, '--record', rec] });

    const one = await enumerateSystemRemotes('box');
    const all = (await enumerateAllRemotes()).find(e => e.system === 'box');
    const viaRoute = await api(ctx.baseUrl, 'GET', '/api/systems/box/remotes');
    const viaTool = await callTool(ctx.baseUrl, 'enumerate_remotes', { system: 'box' });

    assert.equal(viaRoute.status, 200);
    for (const [surface, r] of [['enumerateSystemRemotes', one], ['enumerateAllRemotes', all], ['the route', viaRoute.body]]) {
      assert.equal(r.state, 'not-enumerable', `${surface}: ${JSON.stringify(r)}`);
      assert.equal('remoteIds' in r, false, `${surface} carries no remoteIds`);
    }
    const text = viaTool.content[0].text;
    assert.match(text, /^box · Box\n {2}not enumerable — /m, text);
    assert.doesNotMatch(text, /no configured remotes/, 'the tool does not read the System as empty');

    const frames = await wire(rec);
    assert.ok(frames.length > 0, 'the recorder really saw traffic');
    assert.deepEqual(frames.filter(f => f.type === 'listRemotes'), []);
  });

  // PINS THE GATE'S OTHER DIRECTION — the positive control for the test above:
  // the same recorder, in front of a provider that DOES advertise, sees exactly
  // one `listRemotes` per enumeration. And the frame names no `remoteId`: the set
  // of targets is a fact about the provider, not about one of them.
  test('the recorder sees exactly one listRemotes per enumeration of an advertising provider', async () => {
    const rec = path.join(await mkdtemp('cc-wire-'), 'frames.jsonl');
    const root = await fs.realpath(await mkdtemp('cc-remote-'));
    await addSystem({ id: 'lister', label: 'Lister', launch: ['node', RECORDER, '--record', rec, '--remote', `ctr-a=${root}`] });

    const r = await enumerateSystemRemotes('lister');
    assert.deepEqual(r, { system: 'lister', label: 'Lister', state: 'listed', remoteIds: ['ctr-a'] });

    const sent = (await wire(rec)).filter(f => f.type === 'listRemotes');
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0]).sort(), ['id', 'type']);
  });
});
