// src/claudeUpdate.ts and its routes — Settings → About's `claude update`, run
// the way a worker spawn would run the CLI. The CLI is
// tests/fake-claude-update.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { applyClaudeUpdate } from '../src/claudeUpdate.ts';
import { withMaintenanceLock } from '../src/relaunchPrep.ts';
import { buildRoutes } from '../src/routes.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { mkdtemp } from './tmpRegistry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = `${process.execPath} ${path.join(__dirname, 'fake-claude-update.mjs')}`;

// Runs fn with env overrides, restoring every touched key afterwards.
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

// A fresh dir for one test's record, version and gate files, and the env that
// points the fake at them.
async function withFake(vars, fn) {
  const dir = await mkdtemp('cc-claude-update-');
  const files = { record: path.join(dir, 'record.json'), version: path.join(dir, 'version'), gate: path.join(dir, 'gate') };
  try {
    return await withEnv({
      CLAUDE_BIN: FAKE,
      FAKE_UPDATE_RECORD: files.record,
      FAKE_CLAUDE_VERSION_FILE: files.version,
      FAKE_UPDATE_GATE: files.gate,
      FAKE_UPDATE_MODE: undefined,
      FAKE_UPDATE_TO: undefined,
      ...vars,
    }, () => fn(files, dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function waitForFile(file, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('applyClaudeUpdate runs the resolved CLAUDE_BIN with exactly "update" under the worker env, streams both streams, and returns the re-probed version', async () => {
  await withFake({ FAKE_UPDATE_TO: '2.1.0', CLAUDE_CODE_PROJECT_DIR_NAME: 'x' }, async (files) => {
    const events = [];
    const result = await applyClaudeUpdate({
      platform: hostPlatform,
      onValidated: () => events.push({ validated: true }),
      onChunk: (text) => events.push({ text }),
    });
    const record = JSON.parse(await fs.readFile(files.record, 'utf8'));
    assert.deepEqual(record.argv, ['update']);
    // cliEnvBase strips the host's CLAUDE_CODE_PROJECT_DIR_NAME; process.env would carry it.
    assert.equal(record.projectDirName, null);
    assert.deepEqual(events[0], { validated: true }, 'onValidated fires before the first chunk');
    const text = events.slice(1).map((e) => e.text).join('');
    assert.match(text, /Current version: 2\.0\.0/, 'stdout is streamed');
    assert.match(text, /Checking for updates/, 'stderr is streamed');
    assert.deepEqual(result, { ok: true, version: '2.1.0' });
  });
});

test('a non-zero exit rejects 502 naming the code, with the CLI\'s output as tail; the lock is released', async () => {
  await withFake({ FAKE_UPDATE_MODE: 'fail' }, async () => {
    await assert.rejects(applyClaudeUpdate({ platform: hostPlatform }), (e) => {
      assert.equal(e.statusCode, 502);
      assert.match(e.message, /exited with code 1/);
      assert.match(e.tail, /failed to install update/);
      return true;
    });
    assert.equal(await withMaintenanceLock('restart', async () => 'ok'), 'ok');
  });
});

test('an unrunnable binary rejects 502 naming the command', async () => {
  await withFake({}, async (_files, dir) => {
    const missing = path.join(dir, 'missing-claude');
    await withEnv({ CLAUDE_BIN: missing }, () =>
      assert.rejects(applyClaudeUpdate({ platform: hostPlatform }), (e) => {
        assert.equal(e.statusCode, 502);
        assert.ok(e.message.includes(missing), e.message);
        return true;
      }));
  });
});

test('a hung update is killed at the timeout and rejects 504', async () => {
  await withFake({ FAKE_UPDATE_MODE: 'hang' }, () =>
    assert.rejects(applyClaudeUpdate({ platform: hostPlatform, timeoutMs: 300 }), (e) => {
      assert.equal(e.statusCode, 504);
      assert.match(e.message, /timed out after 300 ms/);
      return true;
    }));
});

test('refused 409 MAINTENANCE_IN_PROGRESS while a restart holds the lock — never spawned', async () => {
  await withFake({}, async (files) => {
    let release;
    const held = new Promise((r) => { release = r; });
    const restart = withMaintenanceLock('restart', () => held);
    try {
      let validated = false;
      await assert.rejects(applyClaudeUpdate({ platform: hostPlatform, onValidated: () => { validated = true; } }), (e) => {
        assert.equal(e.statusCode, 409);
        assert.equal(e.code, 'MAINTENANCE_IN_PROGRESS');
        return true;
      });
      assert.equal(validated, false);
      assert.equal(existsSync(files.record), false, 'the CLI was never spawned');
    } finally {
      release();
      await restart;
    }
  });
});

const ndjson = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Every response the route test opens is read through `read`, so its `finally`
// can release the gate (ending any gated run, a second one a broken lock let
// through included), wait a bounded time for the bodies, then abort and close:
// a regression fails at its assertion instead of hanging server.close().
test('routes: GET /api/settings/claude-update reports the version; POST streams NDJSON; a second POST mid-run is refused 409; a failing CLI is a result ok:false line', async () => {
  await withFake({ FAKE_UPDATE_MODE: 'gate', FAKE_UPDATE_TO: '2.1.0' }, async (files) => {
    const app = express();
    app.use('/api', buildRoutes({}));
    const server = http.createServer(app);
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const url = `http://127.0.0.1:${server.address().port}/api/settings/claude-update`;
    const abort = new AbortController();
    const bodies = [];
    const post = () => fetch(url, { method: 'POST', signal: abort.signal });
    const read = (res) => { const body = res.text(); bodies.push(body.catch(() => {})); return body; };
    try {
      const gres = await fetch(url, { signal: abort.signal });
      assert.equal(gres.status, 200);
      const probe = await gres.json();
      assert.equal(probe.found, true);
      assert.equal(probe.version, '2.0.0');

      const first = await post();
      const firstBody = read(first);
      assert.equal(first.status, 200);
      assert.match(first.headers.get('content-type') || '', /ndjson/);
      await waitForFile(files.record);

      const second = await post();
      const secondBody = read(second);
      assert.equal(second.status, 409);
      assert.match(second.headers.get('content-type') || '', /json/);
      assert.equal(JSON.parse(await secondBody).code, 'MAINTENANCE_IN_PROGRESS');

      await fs.writeFile(files.gate, '');
      const lines = ndjson(await firstBody);
      const chunks = lines.filter((l) => l.type === 'chunk');
      assert.ok(chunks.length > 0, 'chunk lines streamed');
      assert.ok(chunks.every((l) => l.phase === 'update'));
      assert.deepEqual(lines.at(-1), { type: 'result', ok: true, result: { ok: true, version: '2.1.0' } });

      await withEnv({ FAKE_UPDATE_MODE: 'fail' }, async () => {
        const failed = await post();
        const failedBody = read(failed);
        assert.equal(failed.status, 200);
        const result = ndjson(await failedBody).at(-1);
        assert.equal(result.type, 'result');
        assert.equal(result.ok, false);
        assert.match(result.error, /exited with code 1/);
        assert.match(result.tail, /failed to install update/);
      });
    } finally {
      await fs.writeFile(files.gate, '');
      let timer;
      await Promise.race([Promise.all(bodies), new Promise((r) => { timer = setTimeout(r, 5000); })]);
      clearTimeout(timer);
      abort.abort();
      server.closeAllConnections();
      await new Promise((res) => server.close(res));
    }
  });
});
