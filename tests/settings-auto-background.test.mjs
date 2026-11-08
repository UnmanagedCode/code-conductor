// Settings → Models → MCP auto-background: the spawn.autoBackground /
// spawn.autoBackgroundMs keys behind GET /api/settings/spawn and POST
// /api/settings/spawn/prefs, their bounds, and the getter/setter contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api } from './helpers.mjs';
import {
  getAutoBackground, setAutoBackground, setDebugByDefault, getDebugByDefault, setTaskToolsEnabled, getTaskToolsEnabled,
  AUTO_BACKGROUND_MIN_MS, AUTO_BACKGROUND_DEFAULT_MS, AUTO_BACKGROUND_MAX_MS,
} from '../src/appSettings.ts';
import { RUN_CODE_MAX_TIMEOUT_MS, CC_MCP_SERVER_TIMEOUT_MS } from '../src/codeMode/limits.ts';
import { mkdtemp } from './tmpRegistry.mjs';
import { orchStoreRoot } from '../src/projects.ts';

const prefs = (baseUrl, body) => api(baseUrl, 'POST', '/api/settings/spawn/prefs', body);
const spawnGet = async (baseUrl) => (await api(baseUrl, 'GET', '/api/settings/spawn')).body;

test('GET /api/settings/spawn serves autoBackground off at the CLI default with its bounds', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/settings/spawn');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.autoBackground, {
      enabled: false, thresholdMs: AUTO_BACKGROUND_DEFAULT_MS, minMs: AUTO_BACKGROUND_MIN_MS, maxMs: AUTO_BACKGROUND_MAX_MS,
    });
  } finally { await close(); }
});

test('POST autoBackground.enabled persists alone, leaving thresholdMs, taskTools and debugByDefault untouched', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    assert.equal((await prefs(baseUrl, { taskTools: true, debugByDefault: true, autoBackground: { thresholdMs: 30_000 } })).status, 200);
    const on = await prefs(baseUrl, { autoBackground: { enabled: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const expected = {
      debugByDefault: true, taskTools: true,
      autoBackground: { enabled: true, thresholdMs: 30_000, minMs: AUTO_BACKGROUND_MIN_MS, maxMs: AUTO_BACKGROUND_MAX_MS },
    };
    assert.deepEqual(on.body, expected);
    assert.deepEqual(await spawnGet(baseUrl), expected);
  } finally { await close(); }
});

test('POST autoBackground.thresholdMs accepts both bounds and persists them', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    for (const ms of [AUTO_BACKGROUND_MIN_MS, AUTO_BACKGROUND_MAX_MS]) {
      const r = await prefs(baseUrl, { autoBackground: { thresholdMs: ms } });
      assert.equal(r.status, 200, `${ms}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.autoBackground.thresholdMs, ms);
      assert.equal((await spawnGet(baseUrl)).autoBackground.thresholdMs, ms);
    }
  } finally { await close(); }
});

test('POST rejects an out-of-range, non-integer or non-number threshold with 400 and writes nothing', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const before = await spawnGet(baseUrl);
    for (const bad of [AUTO_BACKGROUND_MIN_MS - 1, AUTO_BACKGROUND_MAX_MS + 1, 12_500.5, '120000', null]) {
      const r = await prefs(baseUrl, { taskTools: true, autoBackground: { enabled: true, thresholdMs: bad } });
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
      assert.equal(typeof r.body.error, 'string');
      assert.deepEqual(await spawnGet(baseUrl), before, `${JSON.stringify(bad)}: nothing in the request was saved`);
    }
  } finally { await close(); }
});

test('POST rejects a non-boolean enabled and a non-object autoBackground with 400', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const before = await spawnGet(baseUrl);
    for (const bad of [{ enabled: 'true' }, { enabled: 1 }, true, 'on', [], null]) {
      const r = await prefs(baseUrl, { autoBackground: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(await spawnGet(baseUrl), before, JSON.stringify(bad));
    }
  } finally { await close(); }
});

test('the threshold ceiling is run_code\'s max timeout, below cc\'s MCP server timeout', () => {
  assert.equal(AUTO_BACKGROUND_MAX_MS, RUN_CODE_MAX_TIMEOUT_MS);
  assert.ok(AUTO_BACKGROUND_MAX_MS < CC_MCP_SERVER_TIMEOUT_MS);
  assert.ok(AUTO_BACKGROUND_MIN_MS <= AUTO_BACKGROUND_DEFAULT_MS && AUTO_BACKGROUND_DEFAULT_MS <= AUTO_BACKGROUND_MAX_MS);
});

test('setAutoBackground round-trips through getAutoBackground and throws on an invalid patch', async () => {
  const root = await mkdtemp('cc-settings-autobg-');
  const saved = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  try {
    await setDebugByDefault(true);
    await setTaskToolsEnabled(true);
    assert.deepEqual(getAutoBackground(), { enabled: false, thresholdMs: AUTO_BACKGROUND_DEFAULT_MS });
    assert.deepEqual(await setAutoBackground({ enabled: true }), { enabled: true, thresholdMs: AUTO_BACKGROUND_DEFAULT_MS });
    assert.deepEqual(await setAutoBackground({ thresholdMs: 45_000 }), { enabled: true, thresholdMs: 45_000 });
    assert.deepEqual(getAutoBackground(), { enabled: true, thresholdMs: 45_000 });
    await assert.rejects(() => setAutoBackground({ thresholdMs: 5 }));
    await assert.rejects(() => setAutoBackground({ enabled: 'yes' }));
    assert.deepEqual(getAutoBackground(), { enabled: true, thresholdMs: 45_000 }, 'a refused patch writes nothing');
    assert.equal(getDebugByDefault(), true);
    assert.equal(getTaskToolsEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = saved;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a hand-edited stored threshold outside the bounds or not an integer reads as the default', async () => {
  for (const stored of [AUTO_BACKGROUND_MIN_MS - 1, AUTO_BACKGROUND_MAX_MS + 1, 12_500.5, '30000']) {
    const root = await mkdtemp('cc-settings-autobg-edit-');
    const saved = process.env.PROJECTS_ROOT;
    process.env.PROJECTS_ROOT = root;
    try {
      await fs.mkdir(orchStoreRoot(), { recursive: true });
      await fs.writeFile(path.join(orchStoreRoot(), 'settings.json'),
        JSON.stringify({ spawn: { autoBackground: true, autoBackgroundMs: stored } }));
      assert.deepEqual(getAutoBackground(), { enabled: true, thresholdMs: AUTO_BACKGROUND_DEFAULT_MS }, JSON.stringify(stored));
    } finally {
      if (saved === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = saved;
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
