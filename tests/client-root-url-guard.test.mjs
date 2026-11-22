// Static scan: the client reaches the server only through shared/appUrl.ts, so a
// UI hosted under a prefix (CC_BASE_PATH) never sends a request to the host's
// root. Fails on a raw fetch, a location.host/origin built into a URL, or a
// root-absolute literal given to a URL sink in non-test client sources.
// docs/components/web.md → Base path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'e2e' && e.name !== 'test') out.push(...await walk(p)); }
    else if (/\.(ts|tsx|js)$/.test(e.name) && !/\.test\.|\.proof\./.test(e.name)) out.push(p);
  }
  return out;
}

// A file → why it may carry a line the scan flags. Reasons name the contract that makes it safe.
const EXEMPT = {
  'shared/http.ts': 'the one raw fetch: apiResponse resolves its path through appUrl',
  'shared/appUrl.ts': 'owns the base derivation',
  'web/src/features/views/pluginBridge.js': 'runs inside a plugin frame and derives its mount from the parent page',
};

const QUOTE = `['"\`]`;
const RULES = [
  ['raw fetch(', /(?<![.\w])fetch\(/],
  ['location.host/origin built into a URL', /(?:\+\s*|\$\{\s*)location\.(?:host|origin)\b|location\.(?:host|origin)\s*\+/],
  ['root-absolute literal given to a URL sink',
    new RegExp(`(?:\\.(?:src|href)\\s*=\\s*|\\b(?:src|href)=\\{?\\s*|\\bregister\\(\\s*|new (?:WebSocket|EventSource|Worker)\\(\\s*|window\\.open\\(\\s*|\\bicon:\\s*)${QUOTE}\\/(?!\\/)`)],
];

/** The rules a source line breaks; comment lines never do. */
export function violations(line) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return [];
  return RULES.filter(([, re]) => re.test(line)).map(([name]) => name);
}

test('the scanner flags each offence class (positive control)', () => {
  assert.deepEqual(violations("const r = await fetch('/api/x');"), ['raw fetch(']);
  assert.deepEqual(violations('const u = `ws://${location.host}/ws`;'), ['location.host/origin built into a URL']);
  for (const l of ["f.src = '/plugins/x';", 'register("/sw.js")', 'new WebSocket(`/ws`)', '<img src="/logo.png" />', "icon: '/i.png',", "window.open('/x')"]) {
    assert.deepEqual(violations(l), ['root-absolute literal given to a URL sink'], l);
  }
  for (const ok of ["f.src = appUrl('/plugins/x');", "x.href = '//cdn.example/a'", "const a = origin === location.origin;", '// fetch(x)', "ev.origin !== location.origin"]) {
    assert.deepEqual(violations(ok), [], ok);
  }
});

test('no client source builds a root-absolute URL around appUrl', async () => {
  const files = [...await walk(path.join(root, 'web', 'src')), ...await walk(path.join(root, 'shared'))]
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .filter((f) => !(f in EXEMPT));
  const hits = [];
  for (const f of files) {
    const lines = (await fs.readFile(path.join(root, f), 'utf8')).split('\n');
    lines.forEach((line, i) => { for (const v of violations(line)) hits.push(`${f}:${i + 1} ${v}: ${line.trim()}`); });
  }
  assert.deepEqual(hits, []);
});
