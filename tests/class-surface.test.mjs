import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classSurface } from '../scripts/class-surface.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const surface = (src) => classSurface(`data:text/javascript,${encodeURIComponent(src)}`);

test('class-surface', async (t) => {
  await t.test('lists every prototype member in definition order with its accessor kind', async () => {
    const out = await surface('export class A { constructor(){} b(){} get c(){return 1} set c(v){} get d(){return 1} set e(v){} f(){} }');
    assert.deepEqual(out.filter((l) => !l.startsWith('EXPORT')),
      ['CLASS A', 'method constructor', 'method b', 'getset c', 'get d', 'set e', 'method f']);
  });

  await t.test('lists own statics and excludes the built-in function keys', async () => {
    const out = await surface('export class A { static s(){} static t = 1 }');
    assert.ok(out.includes('static s'));
    assert.ok(out.includes('static t'));
    for (const k of ['length', 'name', 'prototype']) assert.ok(!out.includes(`static ${k}`), k);
  });

  await t.test('async-ness and parameter lists are invisible', async () => {
    const a = await surface('export class A { async m(x, y = 1){} }');
    const b = await surface('export class A { m(...a){ return 0; } }');
    assert.deepEqual(a, b);
  });

  await t.test('EXPORT lines are sorted with typeof, and a re-export equals a local export', async () => {
    const out = await surface('export const b = 1; export const a = 2;');
    assert.deepEqual(out, ['EXPORT a number', 'EXPORT b number']);
    const re = await surface(`export { x } from ${JSON.stringify('data:text/javascript,export const x = 1')};`);
    const local = await surface('export const x = 1;');
    assert.deepEqual(re, local);
    assert.deepEqual(local, ['EXPORT x number']);
  });

  await t.test('the CLI dumps the real instances module non-vacuously', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'cc-surface-'));
    try {
      const out = execFileSync(process.execPath, ['scripts/class-surface.mjs', 'src/instances.ts'], {
        cwd: ROOT, encoding: 'utf8',
        env: { ...process.env, PROJECTS_ROOT: path.join(scratch, 'p'), CLAUDE_PROJECTS_ROOT: path.join(scratch, 'c') },
      });
      const lines = out.split('\n');
      const members = (cls) => {
        const at = lines.indexOf(`CLASS ${cls}`);
        assert.ok(at >= 0, cls);
        let n = 0;
        for (let i = at + 1; i < lines.length && !lines[i].startsWith('CLASS '); i++) if (lines[i]) n++;
        return n;
      };
      assert.ok(members('Instance') >= 100);
      assert.ok(members('InstanceManager') >= 50);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  await t.test('a removed member changes the dump', async () => {
    assert.notDeepEqual(await surface('export class A { a(){} b(){} }'), await surface('export class A { a(){} }'));
  });
});
