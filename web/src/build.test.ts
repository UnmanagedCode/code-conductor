// @vitest-environment node
// The one real Vite build in a gated suite: src/webBuild.ts's ensureWebBuild,
// built into a temp dir outside web/ (webSourceHash walks web/, so an output
// dir there would change the hash between the two calls).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureWebBuild, webSourceHash, type WebState } from '../../src/webBuild.ts';

const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webbuild-'));
const log = { log: vi.fn(), error: vi.fn() };
let first: WebState;

beforeAll(async () => {
  first = await ensureWebBuild({ log, distDir });
}, 120_000);

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.rmSync(`${distDir}.tmp-${process.pid}`, { recursive: true, force: true });
});

describe('ensureWebBuild', () => {
  it('builds, and stamps the output with the source hash', () => {
    expect(log.error).not.toHaveBeenCalled();
    expect(first).toEqual({ phase: 'ready', error: null });
    expect(fs.readFileSync(path.join(distDir, '.source-hash'), 'utf8').trim()).toBe(webSourceHash());
  });

  it('does not rebuild when the sources are unchanged', async () => {
    const index = path.join(distDir, 'index.html');
    const mtime = fs.statSync(index).mtimeMs;
    log.log.mockClear();
    expect(await ensureWebBuild({ log, distDir })).toEqual({ phase: 'ready', error: null });
    expect(log.log).not.toHaveBeenCalled();
    expect(fs.statSync(index).mtimeMs).toBe(mtime);
  });

  it('prefixes every URL in index.html with the /next/ base', () => {
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    expect(html).toMatch(/src="\/next\/assets\/[^"]+\.js"/);
    expect(html).toContain('href="/next/manifest.webmanifest"');
    expect(html).toContain('href="/next/favicon.svg"');
  });

  it('ships a manifest whose scope, start URL and icons resolve under the base', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.webmanifest'), 'utf8'));
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.icons.length).toBeGreaterThan(0);
    expect(manifest.icons.filter((i: { src: string }) => i.src.startsWith('/'))).toEqual([]);
  });
});
