// Static scan: the client reaches the server only through shared/appUrl.ts, so a
// UI hosted under a prefix (CC_BASE_PATH) never sends a request to the host's
// root. Fails on a raw fetch, a location.host/origin built into a URL, or a
// root-absolute literal given to a URL sink in non-test client sources.
// docs/components/web.md → Base path. A Vitest file, not a node test: a node
// test that walks web/src would make every web-only diff select the node suite.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'e2e' && e.name !== 'test') out.push(...walk(p)); }
    else if (/\.(ts|tsx|js)$/.test(e.name) && !/\.test\.|\.proof\./.test(e.name)) out.push(p);
  }
  return out;
}

// A file → why it may carry a line the scan flags. Reasons name the contract that makes it safe.
const EXEMPT: Record<string, string> = {
  'shared/ws.ts': 'builds the ws(s) origin from location.host and appends appUrl(\'/ws\')',
  'shared/http.ts': 'the one raw fetch: apiResponse resolves its path through appUrl',
  'shared/appUrl.ts': 'owns the base derivation',
  'web/src/features/views/pluginBridge.js': 'runs inside a plugin frame and derives its mount from the parent page',
};

const QUOTE = `['"\`]`;
const RULES: [string, RegExp][] = [
  ['raw fetch(', /(?<![.\w])fetch\(/],
  ['location.host/origin built into a URL', /(?:\+\s*|\$\{\s*)location\.(?:host|origin)\b|location\.(?:host|origin)\s*\+/],
  ['root-absolute literal given to a URL sink',
    new RegExp(`(?:\\.(?:src|href)\\s*=\\s*|\\b(?:src|href)=\\{?\\s*|\\bregister\\(\\s*|new (?:WebSocket|EventSource|Worker)\\(\\s*|window\\.open\\(\\s*|\\bicon:\\s*)${QUOTE}\\/(?!\\/)`)],
];

/** The rules a source line breaks; comment lines never do. */
function violations(line: string): string[] {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return [];
  return RULES.filter(([, re]) => re.test(line)).map(([name]) => name);
}

describe('client root-URL guard', () => {
  it('the scanner flags each offence class (positive control)', () => {
    expect(violations("const r = await fetch('/api/x');")).toEqual(['raw fetch(']);
    expect(violations('const u = `ws://${location.host}/ws`;')).toEqual(['location.host/origin built into a URL']);
    for (const l of ["f.src = '/plugins/x';", 'register("/sw.js")', 'new WebSocket(`/ws`)', '<img src="/logo.png" />', "icon: '/i.png',", "window.open('/x')"]) {
      expect(violations(l), l).toEqual(['root-absolute literal given to a URL sink']);
    }
    for (const ok of ["f.src = appUrl('/plugins/x');", "x.href = '//cdn.example/a'", 'const a = origin === location.origin;', '// fetch(x)', 'ev.origin !== location.origin']) {
      expect(violations(ok), ok).toEqual([]);
    }
  });

  it('no client source builds a root-absolute URL around appUrl', () => {
    const files = [...walk(path.join(root, 'web', 'src')), ...walk(path.join(root, 'shared'))]
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .filter((f) => !(f in EXEMPT));
    expect(files.length, 'fixture check: the scan reads client sources').toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
        for (const v of violations(line)) hits.push(`${f}:${i + 1} ${v}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
