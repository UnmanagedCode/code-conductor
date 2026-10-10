// The shared public/*.ts modules: the server and web/ import the sources, and
// the old UI gets them as plain JS from src/legacyPublicTs.ts at / and /legacy/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readdirSync, readFileSync, promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { bootServer } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const get = (url, init) => fetch(url, { redirect: 'manual', ...init });

test('the old UI gets each shared public/*.ts module as JS at / and /legacy/', async (t) => {
  const modules = readdirSync(path.join(REPO, 'public')).filter((f) => f.endsWith('.ts'));
  assert.ok(modules.includes('promptOrigin.ts'), `promptOrigin.ts in ${modules}`);
  assert.ok(modules.length > 1, `more than one module: ${modules}`);
  const dir = await mkdtemp('cc-public-ts-');
  const { baseUrl, close } = await bootServer();
  try {
    for (const file of modules) {
      await t.test(file, async () => {
        const root = await get(`${baseUrl}/${file}`);
        assert.equal(root.status, 200);
        assert.match(root.headers.get('content-type') ?? '', /^text\/javascript/);
        const body = await root.text();

        const legacy = await get(`${baseUrl}/legacy/${file}`);
        assert.equal(legacy.status, 200);
        assert.equal(await legacy.text(), body);

        const out = path.join(dir, file.replace(/\.ts$/, '.mjs'));
        await fs.writeFile(out, body);
        const check = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
        assert.equal(check.status, 0, `node --check ${file} as served:\n${check.stderr}`);
      });
    }
  } finally { await close(); }
});

test("the served module is plain JS with the source's exports", async () => {
  const dir = await mkdtemp('cc-public-ts-');
  const { baseUrl, close } = await bootServer();
  let body;
  try {
    const r = await get(`${baseUrl}/injectedTurns.ts`);
    assert.equal(r.status, 200);
    body = await r.text();
  } finally { await close(); }
  const out = path.join(dir, 'injectedTurns.mjs');
  await fs.writeFile(out, body);
  const served = await import(pathToFileURL(out).href);
  const source = await import('../public/injectedTurns.ts');
  const keys = Object.keys(source).sort();
  assert.ok(keys.length > 0, 'the source has exports');
  assert.deepEqual(Object.keys(served).sort(), keys);
  for (const key of keys) assert.deepEqual(served[key], source[key], key);
});

test('a .ts path outside the shared set is not served', async (t) => {
  const rows = [
    ['/server.ts', 'server.ts', 'express.static(PUBLIC_DIR)'],
    ['/src/webBuild.ts', 'src/webBuild.ts', 'INPUT_DIRS'],
    ['/legacy/src/webBuild.ts', 'src/webBuild.ts', 'INPUT_DIRS'],
    ['/web/base.ts', 'web/base.ts', 'WEB_BASE'],
  ];
  const { baseUrl, close } = await bootServer();
  try {
    for (const [url, file, marker] of rows) {
      await t.test(url, async () => {
        assert.ok(readFileSync(path.join(REPO, file), 'utf8').includes(marker), `${file} contains ${marker}`);
        const r = await get(baseUrl + url);
        assert.equal(r.status, 404);
        assert.ok(!(await r.text()).includes(marker), `${url} leaks ${file}`);
      });
    }
  } finally { await close(); }
});

test('the handler alone: a top-level .ts strips, everything else falls through or fails loudly', async (t) => {
  const { legacyPublicTs } = await import('../src/legacyPublicTs.ts');
  const dir = await mkdtemp('cc-public-ts-fixture-');
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a: number = 1;\n');
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'b.ts'), 'export const b: number = 2;\n');
  await fs.writeFile(path.join(dir, 'bad.ts'), 'export enum E { A }\n');

  const app = express();
  app.use(legacyPublicTs(dir));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await t.test('GET /a.ts is JS with the annotation gone', async () => {
      const r = await get(`${baseUrl}/a.ts`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /^text\/javascript/);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      const body = await r.text();
      assert.match(body, /export const a\s*=\s*1;/);
      assert.ok(!body.includes(': number'), body);
    });
    await t.test('GET /sub/b.ts is not served', async () => {
      assert.equal((await get(`${baseUrl}/sub/b.ts`)).status, 404);
    });
    await t.test('POST /a.ts is not served', async () => {
      assert.equal((await get(`${baseUrl}/a.ts`, { method: 'POST' })).status, 404);
    });
    await t.test('GET /missing.ts is not served', async () => {
      assert.equal((await get(`${baseUrl}/missing.ts`)).status, 404);
    });
    await t.test('GET /bad.ts fails loudly', async () => {
      assert.equal((await get(`${baseUrl}/bad.ts`)).status, 500);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
