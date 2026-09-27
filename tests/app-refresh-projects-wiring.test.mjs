// public/app.js's refreshProjects() is what feeds the Conductors lens's idle
// chips: it fetches GET /api/conductors/projects and hands the body to
// sidebar.setConductorSpawns. app.js cannot be imported (it wires the whole
// page at load), so the real function's source is lifted out of app.js and
// run against a stub fetch and sidebar — its behaviour, not its spelling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..', 'public', 'app.js');

async function loadRefreshProjects() {
  const src = await fs.readFile(APP, 'utf8');
  const m = src.match(/^async function refreshProjects\(\) \{\n[\s\S]*?\n\}\n/m);
  assert.ok(m, 'refreshProjects was renamed or reshaped; update this test\'s slice');
  return new Function('fetch', 'sidebar', 'state', `${m[0]}\nreturn refreshProjects;`);
}

function stubs(responses) {
  const calls = [];
  const sidebar = new Proxy({}, {
    get: (_t, name) => (...args) => { calls.push([name, ...args]); },
  });
  const fetch = async (url) => {
    const r = responses[url];
    if (r instanceof Error) throw r;
    return { ok: r?.ok ?? true, json: async () => r?.body };
  };
  return { calls, sidebar, fetch, state: {} };
}

const BASE = {
  '/api/projects': { body: [{ name: 'p' }] },
  '/api/workspaces': { body: [] },
  '/api/projects/.conduct/sessions': { body: [] },
};

test('refreshProjects hands GET /api/conductors/projects to sidebar.setConductorSpawns', async () => {
  const spawns = { C: [{ project: 'p', lastSpawnAt: '2026-01-01T00:00:00.000Z' }] };
  const s = stubs({ ...BASE, '/api/conductors/projects': { body: spawns } });
  await (await loadRefreshProjects())(s.fetch, s.sidebar, s.state)();
  const hits = s.calls.filter(c => c[0] === 'setConductorSpawns');
  assert.equal(hits.length, 1, 'setConductorSpawns is called once per refresh');
  assert.deepEqual(hits[0][1], spawns);
});

test('a failed or non-ok conductors fetch hands setConductorSpawns an empty map', async (t) => {
  for (const [name, r] of [['non-ok', { ok: false, body: { error: 'x' } }], ['rejected', new Error('offline')]]) {
    await t.test(name, async () => {
      const s = stubs({ ...BASE, '/api/conductors/projects': r });
      await (await loadRefreshProjects())(s.fetch, s.sidebar, s.state)();
      assert.deepEqual(s.calls.filter(c => c[0] === 'setConductorSpawns').map(c => c[1]), [{}]);
    });
  }
});
