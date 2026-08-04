// Direct unit pins on the session-backend sidecar store (src/sessionBackends.ts,
// converted to type-safe TS in round 1). backend-spawn.test.mjs and fork.test.mjs
// pin it through the spawn/resume lifecycle; this file pins the store's
// read/write contract and its corrupt-file stance.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { orchStoreRoot } from '../src/projects.ts';
import { loadAll, getSessionBackend, hasSessionBackend, markSessionBackend, unmarkSessionBackend } from '../src/sessionBackends.ts';

let home;

// Fresh PROJECTS_ROOT per test so the store file starts empty.
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await rmrf(home); });

function storeFile() {
  return path.join(orchStoreRoot(), 'session-backends.json');
}

describe('read/write contract', () => {
  test('a substitution session round-trips backend, exact model, and capacity', async () => {
    assert.equal(await markSessionBackend('s1', 'ollama', 'deepseek-v4-flash:cloud', 1_000_000), true);
    assert.deepEqual(await getSessionBackend('s1'), {
      backend: 'ollama', model: 'deepseek-v4-flash:cloud', contextWindowTokens: 1_000_000,
    });
  });

  test('repeated identical marks converge to one correct record', async () => {
    await markSessionBackend('s1', 'ollama', 'm:1', 200_000);
    await markSessionBackend('s1', 'ollama', 'm:1', 200_000);
    assert.deepEqual(await getSessionBackend('s1'), { backend: 'ollama', model: 'm:1', contextWindowTokens: 200_000 });
    assert.deepEqual([...(await loadAll()).keys()], ['s1'], 'exactly one record after repeated marks');
  });

  test('a null model stays null (backend-known, model-unknown legacy entry)', async () => {
    await markSessionBackend('s1', 'ollama');
    assert.deepEqual(await getSessionBackend('s1'), { backend: 'ollama', model: null, contextWindowTokens: null });
  });

  test('unmark removes the record; unknown sids return false', async () => {
    await markSessionBackend('s1', 'ollama', 'm:1', 200_000);
    assert.equal(await unmarkSessionBackend('s1'), true);
    assert.equal(await getSessionBackend('s1'), null);
    assert.equal(await hasSessionBackend('s1'), false);
    assert.equal(await unmarkSessionBackend('s1'), false);
  });

  test('an empty store reads as empty and absence means the claude backend', async () => {
    assert.equal((await loadAll()).size, 0);
    assert.equal(await getSessionBackend('anything'), null);
    assert.equal(await hasSessionBackend('anything'), false);
  });

  test('guards: empty sid / backend refuse and store nothing', async () => {
    assert.equal(await markSessionBackend('', 'ollama'), false);
    assert.equal(await markSessionBackend('s1', ''), false);
    assert.equal((await loadAll()).size, 0);
  });
});

describe('corrupt store stance', () => {
  test('a corrupt file reads as empty on the read path', async () => {
    await fs.mkdir(path.dirname(storeFile()), { recursive: true });
    await fs.writeFile(storeFile(), '{not json');
    assert.equal((await loadAll()).size, 0);
  });

  test('a mutation refuses on a corrupt file rather than silently overwriting it', async () => {
    await fs.mkdir(path.dirname(storeFile()), { recursive: true });
    await fs.writeFile(storeFile(), '{not json');
    await assert.rejects(markSessionBackend('s1', 'ollama', 'm:1', 200_000));
    assert.equal((await loadAll()).size, 0, 'store must be left untouched');
  });
});
