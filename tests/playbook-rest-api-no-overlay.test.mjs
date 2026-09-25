// GET /api/playbooks on an install whose user-overlay directory does not
// exist yet (userPlaybookIds' ENOENT branch). Its own file because it needs a
// projects root with no `playbooks/` dir, which tests/playbook-rest-api.test.mjs
// populates in its before().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildRoutes } from '../src/routes.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { SEED_PLAYBOOK_IDS } from '../src/playbooks.ts';
import { freshProjectsRoot } from './helpers.mjs';

let server;
let base;

before(async () => {
  await freshProjectsRoot();
  const app = express();
  app.use('/api', buildRoutes({ instances: { list: () => [] } }));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/playbooks`;
});

after(() => new Promise(r => server.close(r)));

test('list: no overlay directory answers 200 with takenIds.user [] and the built-ins loaded', async () => {
  const overlayDir = path.join(orchStoreRoot(), 'playbooks');
  await assert.rejects(() => fs.stat(overlayDir), /ENOENT/, 'precondition: the overlay dir does not exist');
  const res = await fetch(base);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.takenIds.user, []);
  assert.deepEqual(body.playbooks.map(p => p.id).sort(), [...SEED_PLAYBOOK_IDS].sort());
  await assert.rejects(() => fs.stat(overlayDir), /ENOENT/, 'reading never creates the overlay dir');
});
