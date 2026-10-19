// Invariant: every response cc itself produces allows only same-origin framing,
// carries nosniff, and never advertises X-Powered-By.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { bootServer } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const get = (url, init) => fetch(url, { redirect: 'manual', ...init });

function assertPolicy(r) {
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
}

test('responses cc produces carry the framing and nosniff policy', async (t) => {
  const dist = await mkdtemp('cc-sechdr-dist-');
  await fs.mkdir(path.join(dist, 'assets'));
  await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
  await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  await fs.writeFile(path.join(dist, 'assets', 'app.css'), 'body{}');
  await fs.writeFile(path.join(dist, 'manifest.webmanifest'), '{}');
  const { baseUrl, close } = await bootServer({ webDistDir: dist });
  try {
    // Invariant C: the static types nosniff makes load-bearing are correct.
    for (const [p, type] of [
      ['/', /text\/html/],
      ['/assets/app.js', /javascript/],
      ['/assets/app.css', /text\/css/],
      ['/manifest.webmanifest', /application\/manifest\+json/],
    ]) {
      await t.test(`static ${p}`, async () => {
        const r = await get(baseUrl + p);
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type') ?? '', type);
        assertPolicy(r);
      });
    }
    const rows = [
      ['GET /api/health', 'GET', '/api/health', 200],
      ['/api 404 via the error middleware', 'GET', '/api/instances/nope/attachments/x.png', 404],
      ['/api malformed JSON 400', 'POST', '/api/workspaces', 400, { headers: { 'content-type': 'application/json' }, body: '{' }],
      ['bash-forward refusal', 'POST', '/api/instances/nope/bash-forward', null],
      ['GET /mcp 405', 'GET', '/mcp', 405],
      ['unknown plugin 404', 'GET', '/plugins/nope/', 404],
      ['bare plugin id 301', 'GET', '/plugins/nope', 301],
      ['/pluginBridge.js', 'GET', '/pluginBridge.js', 200],
      ['/pluginTheme.css', 'GET', '/pluginTheme.css', null],
      ['/pluginTheme font 404', 'GET', '/pluginTheme/fonts/nope/x.woff2', 404],
    ];
    for (const [name, method, p, status, init] of rows) {
      await t.test(name, async () => {
        const r = await get(baseUrl + p, { method, ...init });
        if (status != null) assert.equal(r.status, status);
        assertPolicy(r);
      });
    }
    // Invariant B: Express's default 404 owns its CSP, so framing rests on X-Frame-Options.
    await t.test("Express's default 404 still forbids cross-origin framing", async () => {
      const r = await get(baseUrl + '/no-such-path');
      assert.equal(r.status, 404);
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-powered-by'), null);
      const fa = (r.headers.get('content-security-policy') ?? '').match(/frame-ancestors[^;]*/);
      if (fa) assert.equal(fa[0], "frame-ancestors 'self'");
    });
  } finally { await close(); }

  const empty = await mkdtemp('cc-sechdr-empty-');
  const b2 = await bootServer({ webDistDir: empty });
  try {
    await t.test('the building page', async () => {
      const r = await get(b2.baseUrl + '/');
      assert.equal(r.status, 503);
      assertPolicy(r);
    });
  } finally { await b2.close(); }
});
