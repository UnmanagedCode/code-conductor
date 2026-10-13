// Every /api response is live state, so the router answers `Cache-Control:
// no-store` on all of them (src/routes.ts, buildRoutes). Two concurrent
// identical GETs against a cacheable response can queue on the browser's cache
// entry lock; no-store takes the cache out of the path.
//
// Invariants: JSON answers, error answers and list answers all carry no-store;
// a route that sets its own Cache-Control (the attachment route) keeps it,
// because the router-wide header is set first and a later setHeader wins.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { attachmentsDir } from '../src/worktrees.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx;
before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  const created = await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
  assert.equal(created.status, 201);
});
after(async () => { await ctx.close(); });

test('every /api JSON response is Cache-Control: no-store', async (t) => {
  const routes = [
    ['GET /api/projects', 200],
    ['GET /api/projects/demo/sessions', 200],
    ['GET /api/instances', 200],
    ['GET /api/projects/nope/sessions', 404],
  ];
  for (const [label, status] of routes) {
    await t.test(label, async () => {
      const res = await fetch(ctx.baseUrl + label.slice(4));
      assert.equal(res.status, status);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  }
});

test('a route that sets its own Cache-Control keeps it', async () => {
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  const id = r.body.id;
  await waitFor(() => ctx.instances.get(id).status === 'idle');
  const dir = attachmentsDir('demo', null);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'stamp-a.png'), Buffer.from('x'));
  const res = await fetch(`${ctx.baseUrl}/api/instances/${id}/attachments/stamp-a.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
});
