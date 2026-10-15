// The host-served plugin theme (/pluginTheme.css, src/pluginTheme.ts) and what
// docs/plugin-ui.md tells plugin authors about it: the sheet is the host's own
// palette with no build in place, its fonts resolve, the recipe's token mapping
// is the host's, and a built-in UI plugin's library hook builds it on install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import { bootServer } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';
import { makePluginRoot } from './plugin-helpers.mjs';
import { createPluginLibrary } from '../src/plugins/library.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { pluginThemeRouter } from '../src/pluginTheme.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const INDEX_CSS = path.join(REPO, 'web', 'src', 'index.css');
const run = promisify(execFile);

// ── a minimal CSS reader: top-level rules, their declarations, relative @imports ──

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The rules at brace depth 0 of `css`, as {prelude, body}; statements without a block are skipped. */
function rules(css) {
  const out = [];
  let depth = 0, start = 0, preludeStart = 0, prelude = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) { prelude = css.slice(preludeStart, i).trim(); start = i + 1; }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) { out.push({ prelude, body: css.slice(start, i) }); preludeStart = i + 1; }
    } else if (c === ';' && depth === 0) {
      preludeStart = i + 1;
    }
  }
  return out;
}

/** The declarations directly in a rule body (nested rules dropped), in order, as [name, value]. */
function declarations(body) {
  let flat = '', depth = 0;
  for (const c of body) {
    if (c === '{') depth++;
    else if (c === '}') { depth--; flat += ';'; continue; }
    if (depth === 0) flat += c;
  }
  // A nested rule's prelude is left behind as a segment without a colon-led declaration shape; drop those.
  return flat.split(';').map((d) => d.trim()).filter((d) => /^[-a-z]+\s*:/.test(d))
    .map((d) => { const k = d.indexOf(':'); return [d.slice(0, k).trim(), d.slice(k + 1).trim()]; });
}

/** `file` with every relative `@import './x.css';` replaced by that file's (recursively inlined) text. */
async function inlineImports(file) {
  const css = await fs.readFile(file, 'utf8');
  let out = '';
  let last = 0;
  for (const m of css.matchAll(/@import\s+['"](\.{1,2}\/[^'"]+)['"]\s*;/g)) {
    out += css.slice(last, m.index) + await inlineImports(path.resolve(path.dirname(file), m[1]));
    last = m.index + m[0].length;
  }
  return out + css.slice(last);
}

/** The custom properties (and `color-scheme`) of the top-level `:root` and `.dark` rules, last declaration winning. */
function palette(css) {
  const out = { ':root': new Map(), '.dark': new Map() };
  for (const r of rules(stripComments(css))) {
    if (!(r.prelude in out)) continue;
    for (const [k, v] of declarations(r.body)) if (k.startsWith('--') || k === 'color-scheme') out[r.prelude].set(k, v);
  }
  return out;
}

/** The `@theme inline` block's `--color-*` / `--radius-*` / `--font-*` entries, as a Map. */
function themeMapping(css) {
  const block = rules(stripComments(css)).find((r) => r.prelude === '@theme inline');
  assert.ok(block, 'an @theme inline block');
  return new Map(declarations(block.body).filter(([k]) => /^--(color|radius|font)-/.test(k)));
}

/** Every `url(...)` the sheet references, unquoted. */
const urls = (sheet) => [...sheet.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));

const firstFamily = (stack) => stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');

// ── the served sheet ──

test('the served plugin theme, booted with no build', async (t) => {
  const distDir = await mkdtemp('cc-plugin-theme-nodist-');
  const { baseUrl, close } = await bootServer({ webDistDir: distDir });
  try {
    const r = await fetch(baseUrl + '/pluginTheme.css');
    const sheet = r.status === 200 ? await r.text() : '';

    await t.test("/pluginTheme.css serves the host's exact palette, with no build", async () => {
      // Invariant: the served sheet cannot differ from the host's effective tokens — an index.css override, a removed @import, a mapped token missing from the shared file, or a stale served copy all fail it.
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /^text\/css/);
      assert.equal(r.headers.get('cache-control'), 'no-cache', 'revalidated on every load, as docs/plugins.md and docs/protocol.md promise');
      const host = palette(await inlineImports(INDEX_CSS));
      const served = palette(sheet);
      for (const scope of [':root', '.dark']) {
        assert.ok(served[scope].size > 0, `the sheet has a ${scope} block`);
        for (const [k, v] of served[scope]) assert.equal(host[scope].get(k), v, `${scope} ${k}: the host's effective value`);
      }
      const mapping = themeMapping(await fs.readFile(INDEX_CSS, 'utf8'));
      const referenced = new Set([...mapping].filter(([k]) => /^--(color|radius)-/.test(k))
        .flatMap(([, v]) => [...v.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1])));
      assert.ok(referenced.size > 0, "fixture check: index.css's @theme inline references tokens");
      for (const k of referenced) {
        assert.ok(served[':root'].has(k), `${k}, mapped by @theme inline, is served in :root`);
        if (host['.dark'].has(k)) assert.ok(served['.dark'].has(k), `${k} is served in .dark`);
      }
      assert.equal(served['.dark'].get('color-scheme'), 'dark');
      const marker = sheet.indexOf('/* cc:tokens */');
      assert.ok(marker >= 0, 'the /* cc:tokens */ marker');
      assert.ok(marker < sheet.indexOf(':root'), 'the marker precedes the tokens');
      assert.ok(!sheet.slice(marker).includes('@font-face'), 'every font-face precedes the marker');
    });

    await t.test("every palette property index.css declares itself is served, unless it is host-only", async () => {
      // Invariant: a token added to index.css's own :root/.dark instead of themeTokens.css fails here unless it matches the host-only allowlist (--header-height, --mascot-*).
      const HOST_ONLY = /^--(header-height$|mascot-)/;
      const own = palette(await fs.readFile(INDEX_CSS, 'utf8'));
      const served = palette(sheet);
      let hostOnly = 0;
      for (const scope of [':root', '.dark']) {
        for (const k of own[scope].keys()) {
          if (HOST_ONLY.test(k)) { hostOnly++; continue; }
          assert.ok(served[scope].has(k), `${scope} ${k}, declared in index.css, is served (or belongs in the host-only allowlist)`);
        }
      }
      assert.ok(hostOnly > 0, "fixture check: index.css's own blocks are read");
    });

    await t.test("the served fonts resolve and match the host's font stack", async () => {
      // Invariant: the fonts the recipe names are served, and the recipe's @theme inline mapping is the host's.
      const fontUrls = urls(sheet);
      assert.ok(fontUrls.length > 0, 'the sheet references font files');
      for (const u of fontUrls) {
        const f = await fetch(new URL(u, baseUrl + '/pluginTheme.css'));
        assert.equal(f.status, 200, u);
        assert.equal(f.headers.get('content-type'), 'font/woff2', u);
        await f.arrayBuffer();
      }
      const faces = rules(stripComments(sheet)).filter((x) => x.prelude === '@font-face')
        .map((x) => Object.fromEntries(declarations(x.body)));
      const families = new Set(faces.map((f) => firstFamily(f['font-family'])));
      const mapping = themeMapping(await fs.readFile(INDEX_CSS, 'utf8'));
      assert.deepEqual([...families].sort(), [firstFamily(mapping.get('--font-sans')), firstFamily(mapping.get('--font-mono'))].sort(),
        "the served families are the first family of index.css's --font-sans and --font-mono");
      for (const fam of families) assert.ok(faces.some((f) => firstFamily(f['font-family']) === fam && /url\(/.test(f.src)), `${fam} has a served file`);

      const doc = await fs.readFile(path.join(REPO, 'docs', 'plugin-ui.md'), 'utf8');
      const block = [...doc.matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes('@theme inline'));
      assert.ok(block, "docs/plugin-ui.md has a css block with @theme inline");
      assert.deepEqual([...themeMapping(block)].sort(), [...mapping].sort(), "the recipe's @theme inline is index.css's");
    });

    await t.test("the font route refuses anything but an allowlisted package's .woff2", async () => {
      // Invariant: the font route exposes only font files of the allowlisted packages.
      const good = urls(sheet)[0];
      assert.ok(good, 'fixture check: a served font url');
      const file = good.split('/').pop();
      for (const p of [
        `/pluginTheme/fonts/not-a-pkg/${file}`,
        `/pluginTheme/fonts/geist/..%2F..%2Fpackage.json`,
        `/pluginTheme/fonts/geist/..%2Findex.css`,
        `/pluginTheme/fonts/geist/index.css`,
        `/pluginTheme/fonts/geist/${file.replace(/\.woff2$/, '.woff')}`,
        `/pluginTheme/fonts/geist/${file.toUpperCase()}`,
      ]) {
        const res = await fetch(baseUrl + p);
        assert.equal(res.status, 404, p);
        await res.arrayBuffer();
      }
    });
  } finally { await close(); }
});

test('a /pluginTheme.css that cannot be composed answers 503 text/plain with a fixed body, and logs the cause', async (t) => {
  // Invariant: a compose failure never reaches the client as a stack trace or a filesystem path — the page gets 503 "host theme unavailable", the log gets the error.
  const dir = await mkdtemp('cc-plugin-theme-broken-');
  const missing = path.join(dir, 'no-such-themeTokens.css');
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args); });
  const app = express();
  app.use(pluginThemeRouter({ tokensFile: missing }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/pluginTheme.css`);
    const body = await r.text();
    assert.equal(r.status, 503);
    assert.match(r.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(body, 'host theme unavailable');
    assert.ok(!body.includes(dir), 'the path is not on the page');
    assert.equal(logged.length, 1, 'the failure is logged once');
    assert.match(logged[0].map(String).join(' '), /no-such-themeTokens\.css/, 'the log names the cause');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rmrf(dir);
  }
});

// ── what Install runs ──

async function git(cwd, ...args) { await run('git', ['-C', cwd, ...args]); }

test('a built-in UI plugin\'s library hook is a plain npm install that installs devDependencies and runs prepare', async () => {
  // Invariant: what docs/plugin-ui.md tells authors about Install holds — the hook, in cc's own (npm start-style) env, installs devDependencies and runs the root prepare in the checkout, and the built-in code-wiki and code-live entries run it.
  const env = await makePluginRoot();
  const C = await mkdtemp('theme-lib-cat-');
  const seed = await mkdtemp('theme-lib-seed-');
  const decoy = await mkdtemp('theme-lib-decoy-');
  const ENV_KEYS = ['npm_config_local_prefix', 'npm_lifecycle_event', 'npm_config_audit', 'npm_config_fund', 'npm_config_update_notifier'];
  const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    // The fixture plugin: its prepare needs a devDependency, and writes dist/built.
    await fs.mkdir(path.join(seed, 'vendor', 'devtool'), { recursive: true });
    await fs.writeFile(path.join(seed, 'vendor', 'devtool', 'package.json'), JSON.stringify({ name: 'devtool', version: '1.0.0', main: 'index.js' }));
    await fs.writeFile(path.join(seed, 'vendor', 'devtool', 'index.js'), "module.exports = 'built by devtool';\n");
    await fs.writeFile(path.join(seed, 'build.cjs'),
      "const fs = require('fs');\nfs.mkdirSync('dist', { recursive: true });\nfs.writeFileSync('dist/built', require('devtool'));\n");
    await fs.writeFile(path.join(seed, 'package.json'), JSON.stringify({
      name: 'ui-fixture', version: '1.0.0', private: true,
      scripts: { prepare: 'node build.cjs' },
      devDependencies: { devtool: 'file:./vendor/devtool' },
    }, null, 2));
    await git(seed, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(seed, 'config', 'user.email', 'test@test');
    await git(seed, 'config', 'user.name', 'test');
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-q', '-m', 'v1');
    const mirror = path.join(C, 'repos', 'ui-fixture.git');
    await fs.mkdir(path.dirname(mirror), { recursive: true });
    await run('git', ['clone', '-q', '--bare', seed, mirror]);
    await fs.mkdir(orchStoreRoot(), { recursive: true });
    await fs.writeFile(path.join(orchStoreRoot(), 'settings.json'), JSON.stringify({ plugins: { libraryDirs: [C] } }));
    await fs.writeFile(path.join(C, 'ui-fixture.json'), JSON.stringify({
      id: 'ui-fixture', name: 'UI fixture', repo: 'catalog:repos/ui-fixture.git', postClone: 'npm install', postPull: 'npm install',
    }));

    const lib = createPluginLibrary();
    const { entries } = await lib.list();
    for (const id of ['code-wiki', 'code-live']) {
      const row = entries.find((e) => e.id === id);
      assert.equal(row?.postClone, 'npm install', `${id} postClone`);
      assert.equal(row?.postPull, 'npm install', `${id} postPull`);
    }

    // A cc launched by `npm start` carries these; npm must still install into the checkout.
    Object.assign(process.env, {
      npm_config_local_prefix: decoy, npm_lifecycle_event: 'start',
      npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    });
    const res = await lib.install('ui-fixture');
    assert.ok(res.postClone?.ok, `postClone ok: ${JSON.stringify(res.postClone)}`);
    assert.equal(await fs.readFile(path.join(res.path, 'dist', 'built'), 'utf8'), 'built by devtool', 'prepare ran, with the devDependency');
    assert.ok((await fs.lstat(path.join(res.path, 'node_modules', 'devtool'))), 'the devDependency is installed in the checkout');
    assert.deepEqual(await fs.readdir(decoy), [], 'nothing is written under the inherited npm prefix');
  } finally {
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    await env.restore();
    await rmrf(C);
    await rmrf(seed);
    await rmrf(decoy);
  }
});
