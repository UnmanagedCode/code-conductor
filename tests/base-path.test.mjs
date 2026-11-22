import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewritePluginHostUrls } from '../src/plugins/proxy.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseBasePath, stripBasePath, reservedRootSegments } from '../src/basePath.ts';

test('parseBasePath: unset, empty and "/" all mean root', () => {
  for (const v of [undefined, null, '', '/']) assert.equal(parseBasePath(v), '');
});

test('parseBasePath: one trailing slash is normalised away', () => {
  assert.equal(parseBasePath('/p/q/'), '/p/q');
  assert.equal(parseBasePath('/p/q'), '/p/q');
});

test('parseBasePath: refuses a value that is not a clean path prefix', () => {
  for (const bad of ['p/q', '/p//q', '/p/./q', '/p/../q', '//', '/p?x', '/p#x', '/p%20q', '/p q', '/p/q//']) {
    assert.throws(() => parseBasePath(bad), /CC_BASE_PATH/, bad);
  }
});

test("parseBasePath: no HTML- or attribute-significant character is ever accepted in a segment", () => {
  // Invariant: a base is spliced into rewritten HTML attributes, so its charset is the unreserved set only.
  for (const bad of ["/x'onload='alert(1)", '/x"y', '/x<y', '/x>y', '/x&y', '/x`y', '/x(y)', '/x;y', '/x=y', '/x:y', '/x@y', '/x,y', '/x+y', '/x*y', '/x!y', '/x$y', '/x\\y']) {
    assert.throws(() => parseBasePath(bad), /CC_BASE_PATH/, bad);
  }
  assert.equal(parseBasePath('/a.b_c~d-9/Z'), '/a.b_c~d-9/Z');
});

test("parseBasePath: a first segment that cc serves at root is refused, deeper segments are not", () => {
  // Invariant: a base never shadows a root mount, so loopback callers' root URLs keep resolving.
  for (const bad of ['/api', '/api/x', '/mcp', '/ws', '/plugins', '/plugins/', '/plugins/Bad_Id', '/pluginBridge.js', '/pluginTheme.css', '/pluginTheme', '/sw.js', '/manifest.webmanifest', '/assets', '/icon-192.png', '/favicon-16.png', '/index.html']) {
    assert.throws(() => parseBasePath(bad), /CC_BASE_PATH.*(root|serves)/, bad);
  }
  assert.equal(parseBasePath('/apps/api'), '/apps/api');
  assert.equal(parseBasePath('/apps/mcp'), '/apps/mcp');
});

test('parseBasePath: /plugins/<id> and deeper are accepted, a bare /plugins is refused', () => {
  // Invariant: cc can be fronted by another cc's plugin mount (the approved criterion); only the bare mount, which no plugin id completes, stays refused.
  assert.equal(parseBasePath('/plugins/cc2'), '/plugins/cc2');
  assert.equal(parseBasePath('/plugins/cc2/'), '/plugins/cc2');
  assert.equal(parseBasePath('/plugins/cc2/x'), '/plugins/cc2/x');
  assert.throws(() => parseBasePath('/plugins'), /CC_BASE_PATH/);
});

test('reservedRootSegments covers every root mount server.ts and the plugin theme router declare, and every file in web/public', async () => {
  // Invariant: the reserved list is derived from what is served at root, not hand-copied: a new mount or public file that is missing here fails.
  const reserved = reservedRootSegments();
  const root = path.resolve(import.meta.dirname, '..');
  const first = (p) => p.split('/')[1];
  const mounts = [];
  for (const [file, re] of [['server.ts', /app\.(?:use|get)\(\s*'(\/[^']*)'/g], ['src/pluginTheme.ts', /router\.get\(\s*'(\/[^']*)'/g]]) {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    for (const m of text.matchAll(re)) mounts.push(first(m[1]));
  }
  assert.ok(mounts.includes('api') && mounts.includes('pluginTheme.css'), 'fixture check: the scan finds the mounts');
  for (const m of mounts.filter(Boolean)) assert.ok(reserved.has(m), `${m} is a root mount`);
  const pub = await fs.readdir(path.join(root, 'web', 'public'));
  assert.ok(pub.length > 0);
  for (const f of pub) assert.ok(reserved.has(f), `${f} is a public file`);
  assert.ok(reserved.has('ws'), '/ws is dispatched by the upgrade handler');
  assert.ok(reserved.has('assets'), "Vite's asset dir");
});

test('stripBasePath: a prefixed path loses the base, a root path is untouched', () => {
  assert.deepEqual(stripBasePath('/p/q', '/p/q/api/x?a=1'), { url: '/api/x?a=1' });
  assert.deepEqual(stripBasePath('/p/q', '/p/q/'), { url: '/' });
  assert.deepEqual(stripBasePath('/p/q', '/api/x'), { url: '/api/x' });
});

test('stripBasePath: a near-miss prefix is not stripped', () => {
  assert.deepEqual(stripBasePath('/p/q', '/p/qr/x'), { url: '/p/qr/x' });
});

test('stripBasePath: a bare base redirects to the trailing-slash form, query kept', () => {
  assert.deepEqual(stripBasePath('/p/q', '/p/q'), { redirect: '/p/q/' });
  assert.deepEqual(stripBasePath('/p/q', '/p/q?a=1'), { redirect: '/p/q/?a=1' });
});

test('stripBasePath: with no base it is the identity', () => {
  assert.deepEqual(stripBasePath('', '/p/q/api'), { url: '/p/q/api' });
});

const buf = (t) => Buffer.from(t, 'latin1');

test('rewritePluginHostUrls: an attribute-shaped bridge or theme URL is re-rooted in both quote styles', () => {
  const html = buf(`<script src="/pluginBridge.js"></script><link href='/pluginTheme.css' rel=stylesheet>`);
  assert.equal(rewritePluginHostUrls(html, '/p/q').toString('latin1'),
    `<script src="/p/q/pluginBridge.js"></script><link href='/p/q/pluginTheme.css' rel=stylesheet>`);
});

test('rewritePluginHostUrls: each non-matching shape is left byte-identical', () => {
  // Invariant: only `src|href = quote /pluginBridge.js|/pluginTheme.css quote` is rewritten; a longer name, a relative or other URL, an unquoted or mismatched-quote value, and the bare path in text stay.
  for (const same of [
    '<script src="/pluginBridge.jsx"></script>', '<img src="/a.png">', '<script src="../../pluginBridge.js"></script>',
    '<script src=/pluginBridge.js></script>', `<script src="/pluginBridge.js'></script>`, '<p>/pluginBridge.js</p>',
    '<script src="/x/pluginBridge.js"></script>', '<link href="/pluginTheme.css.map">',
  ]) {
    assert.equal(rewritePluginHostUrls(buf(same), '/p/q').toString('latin1'), same, same);
  }
});

test('rewritePluginHostUrls: the match is by bytes, so attribute-shaped text is rewritten too', () => {
  // Pins the documented limit: the rewrite is not markup-aware.
  assert.equal(rewritePluginHostUrls(buf('<p>src="/pluginBridge.js"</p>'), '/p/q').toString('latin1'), '<p>src="/p/q/pluginBridge.js"</p>');
});

test('rewritePluginHostUrls: every byte outside the two values survives, whatever the charset', () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const html = Buffer.concat([all, buf('<script src="/pluginBridge.js">'), all]);
  const out = rewritePluginHostUrls(html, '/p/q');
  assert.deepEqual(out, Buffer.concat([all, buf('<script src="/p/q/pluginBridge.js">'), all]));
});

test('rewritePluginHostUrls: no base is the identity', () => {
  const html = buf('<script src="/pluginBridge.js"></script>');
  assert.equal(rewritePluginHostUrls(html, ''), html);
});
