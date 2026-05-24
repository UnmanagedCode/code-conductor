import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from './helpers.mjs';

test('serves a valid Web App Manifest', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await fetch(baseUrl + '/manifest.webmanifest');
    assert.equal(r.status, 200);
    const m = await r.json();
    assert.equal(m.name, 'CodeConductor');
    assert.equal(m.display, 'standalone');
    assert.equal(m.start_url, '/');
    // launch_handler.client_mode=navigate-existing tells Chrome on Android
    // to reuse the existing PWA tab when relaunching (e.g. when returning
    // from a Chrome browser tab) instead of cold-starting and dropping the
    // session anchor in the URL hash.
    assert.deepEqual(m.launch_handler, { client_mode: 'navigate-existing' });
    assert.ok(Array.isArray(m.icons) && m.icons.length >= 1, 'icons[] must be non-empty');
    const purposes = new Set(m.icons.map(i => i.purpose));
    assert.ok(purposes.has('any'), 'needs an icon with purpose="any"');
    assert.ok(purposes.has('maskable'), 'needs an icon with purpose="maskable" for Android adaptive masks');
    for (const icon of m.icons) {
      const ir = await fetch(baseUrl + icon.src);
      assert.equal(ir.status, 200, `icon ${icon.src} must be served`);
    }
  } finally { await close(); }
});

test('serves the SVG icon with the right shape', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await fetch(baseUrl + '/icon.svg');
    assert.equal(r.status, 200);
    const ctype = r.headers.get('content-type') || '';
    assert.match(ctype, /image\/svg/, `expected image/svg content-type, got ${ctype}`);
    const body = await r.text();
    assert.match(body, /<svg[\s>]/);
    assert.match(body, /<\/svg>/);
    assert.match(body, /<text[\s>][\s\S]*?CC[\s\S]*?<\/text>/, 'icon should contain the CC monogram');
  } finally { await close(); }
});

test('index.html wires up the manifest and theme color', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await fetch(baseUrl + '/');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/);
    assert.match(html, /<meta\s+name="theme-color"\s+content="#0f1117"/);
    assert.match(html, /<title>CodeConductor<\/title>/);
  } finally { await close(); }
});
