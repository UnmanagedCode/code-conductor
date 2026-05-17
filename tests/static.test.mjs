import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, api } from './helpers.mjs';

test('serves index.html with module entry', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await fetch(baseUrl + '/');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<script type="module" src="\/app\.js">/);
    assert.match(html, /id="conversation"/);
    assert.match(html, /id="mode-select"/);
  } finally { await close(); }
});

test('serves each public asset', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    for (const asset of ['/app.js', '/ws.js', '/sidebar.js', '/conversation.js', '/blocks.js', '/composer.js', '/styles.css', '/sw.js', '/notifications.js', '/diff.js']) {
      const r = await fetch(baseUrl + asset);
      assert.equal(r.status, 200, `expected 200 for ${asset}`);
      const len = Number(r.headers.get('content-length') ?? 0);
      assert.ok(len > 0, `${asset} should be non-empty`);
    }
  } finally { await close(); }
});

test('DOM-free public modules import cleanly in Node', async () => {
  // Use file:// imports — these modules have no top-level browser-globals
  // access, so a successful import proves their syntax + imports resolve.
  // app.js touches document at top level so it's excluded.
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const pub = path.resolve(here, '..', 'public');
  for (const asset of ['blocks.js', 'sidebar.js', 'conversation.js', 'composer.js']) {
    const mod = await import(url.pathToFileURL(path.join(pub, asset)).href);
    assert.ok(mod, `${asset} imported`);
  }
});
