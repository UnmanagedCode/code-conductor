// @vitest-environment node
// The one real Vite build in a gated suite: src/webBuild.ts's ensureWebBuild,
// built into a temp dir outside web/ (webSourceHash walks web/, so an output
// dir there would change the hash between the two calls).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { ensureWebBuild, webHandler, webSourceHash, WEB_MOUNT, WEB_ROOT, type WebState } from '../../src/webBuild.ts';

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

  it('the input hash ignores build leftovers (dist.tmp-*, dist.old-*) but not a new source dir', () => {
    const before = webSourceHash();
    const tag = `${process.pid}-${Date.now()}`;
    const probe = (name: string) => {
      const dir = path.join(WEB_ROOT, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'a.js'), 'x');
      try { return webSourceHash(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    expect(probe(`dist.tmp-${tag}`)).toBe(before);
    expect(probe(`dist.old-${tag}`)).toBe(before);
    expect(probe(`probe-${tag}`)).not.toBe(before);
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

describe('ensureWebBuild failures resolve `failed`, never reject (start() fires it unawaited)', () => {
  const quiet = () => ({ log: vi.fn(), error: vi.fn() });
  const dirs: string[] = [];
  const freshDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webbuild-fail-')); dirs.push(d); return d; };
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  it('an input that cannot be read', async () => {
    const realRead = fs.readFileSync;
    const input = path.join(WEB_ROOT, 'index.html');
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (p === input) throw Object.assign(new Error(`EACCES: permission denied, open '${input}'`), { code: 'EACCES' });
      return (realRead as any)(p, ...rest);
    }) as typeof fs.readFileSync);
    const log = quiet();
    await expect(ensureWebBuild({ log, distDir: freshDir() })).resolves.toEqual({ phase: 'failed', error: expect.stringContaining('EACCES') });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('a swap that fails keeps the previous build in place and served', async () => {
    const dist = freshDir();
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><p>previous-build</p>');
    fs.writeFileSync(path.join(dist, '.source-hash'), 'stale\n');
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(`${dist}.tmp-`)) throw Object.assign(new Error('EXDEV: injected rename failure'), { code: 'EXDEV' });
      return realRename(from, to);
    });
    const log = quiet();
    const result = await ensureWebBuild({ log, distDir: dist });
    expect(result).toEqual({ phase: 'failed', error: expect.stringContaining('EXDEV') });
    expect(String(log.error.mock.calls[0][0])).toContain('serving the previous build');
    expect(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')).toContain('previous-build');
    const parent = path.dirname(dist);
    expect(fs.readdirSync(parent).filter((n) => n.startsWith(`${path.basename(dist)}.`))).toEqual([]);

    const app = express();
    app.use(WEB_MOUNT, webHandler({ distDir: dist, getState: () => result }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const r = await fetch(`http://127.0.0.1:${port}${WEB_MOUNT}/`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('previous-build');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }, 120_000);
});
