// @vitest-environment node
// The only real Vite builds in a gated suite: src/webBuild.ts's ensureWebBuild,
// built into temp dirs outside web/ (webSourceHash walks web/, so an output dir
// there would change the hash between calls). Nothing here writes under web/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { ensureWebBuild, webHandler, webSourceHash, WEB_ROOT, type WebState } from '../../src/webBuild.ts';

const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webbuild-'));
const log = { log: vi.fn(), error: vi.fn() };
let first: WebState;
const viteWarnings: string[] = [];

// Vitest sets NODE_ENV=test, which makes Vite build the development bundle;
// the server builds under production, so this build does too.
async function productionBuild(opts: Parameters<typeof ensureWebBuild>[0]) {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { return await ensureWebBuild(opts); } finally {
    if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
  }
}

beforeAll(async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { viteWarnings.push(a.join(' ')); });
  try { first = await productionBuild({ log, distDir }); } finally { warn.mockRestore(); }
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

  it('sweeps <dist>.tmp-<pid> / .old-<pid> leftovers of dead processes, never a live one\'s', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const sibling = (suffix: string) => { const d = `${distDir}${suffix}`; fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'x'), 'x'); return d; };
    const swept = [sibling(`.tmp-${dead}`), sibling(`.old-${dead}`)];
    const kept = [sibling(`.tmp-${process.ppid}`), sibling(`.old-${process.ppid}`), sibling(`.tmp-${process.pid}`), sibling('.tmp-notapid')];
    try {
      expect(await ensureWebBuild({ log, distDir })).toEqual({ phase: 'ready', error: null });
      expect(swept.filter((d) => fs.existsSync(d))).toEqual([]);
      expect(kept.filter((d) => !fs.existsSync(d))).toEqual([]);
    } finally { for (const d of [...swept, ...kept]) fs.rmSync(d, { recursive: true, force: true }); }
  });

  it('builds the production bundle the server ships: no chunk over 800 kB, no size warning', () => {
    // Pinned here, not read from the config this guards: raising chunkSizeWarningLimit must not disarm it.
    const limitBytes = 800 * 1000;
    const assets = path.join(distDir, 'assets');
    const sizes = fs.readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => fs.statSync(path.join(assets, f)).size);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThan(limitBytes);
    expect(viteWarnings.filter((w) => /chunks are larger than/.test(w))).toEqual([]);
  });

  it('every URL in index.html is root-absolute: the entry chunk, the manifest and the favicon', () => {
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    expect(html).toMatch(/src="\/assets\/[^"]+\.js"/);
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('href="/favicon.svg"');
  });

  it('ships a manifest whose start URL and scope resolve to / and that sets no other id, so an app installed from the old UI keeps its identity; it launches navigate-existing with any and maskable icons', () => {
    // Invariant: an install's id is its start URL unless `id` says otherwise, and the old UI's was `/`.
    const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.webmanifest'), 'utf8'));
    const served = 'http://h/manifest.webmanifest';
    expect(new URL(manifest.start_url, served).pathname).toBe('/');
    expect(new URL(manifest.scope, served).pathname).toBe('/');
    if (manifest.id !== undefined) expect(new URL(manifest.id, new URL(manifest.start_url, served)).pathname).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.launch_handler).toEqual({ client_mode: 'navigate-existing' });
    const purposes = manifest.icons.flatMap((i: { purpose?: string }) => (i.purpose ?? 'any').split(/\s+/));
    expect(purposes).toEqual(expect.arrayContaining(['any', 'maskable']));
    expect(manifest.icons.filter((i: { src: string }) => i.src.startsWith('/'))).toEqual([]);
  });
});

describe('serving the built UI', () => {
  it('serves every shipped file under the mount, non-empty, with the index reachable at the mount root', async () => {
    // Invariant: each file the build emits (document, manifest, icons, chunks) is answered 200 with a body, so nothing the page references is missing.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (!e.name.startsWith('.')) files.push(path.relative(distDir, full).split(path.sep).join('/'));
      }
    };
    walk(distDir);
    expect(files).toContain('index.html');
    expect(files.some((f) => f.startsWith('assets/') && f.endsWith('.js'))).toBe(true);
    expect(files).toContain('manifest.webmanifest');

    const app = express();
    app.use(webHandler({ distDir, getState: () => first }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const bad: string[] = [];
      for (const f of ['', ...files]) {
        const r = await fetch(`${base}/${f}`);
        const body = await r.arrayBuffer();
        if (r.status !== 200 || body.byteLength === 0) bad.push(`${f || '/'} -> ${r.status}, ${body.byteLength} bytes`);
      }
      expect(bad).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('webSourceHash over a fixture root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webhash-'));
  const web = path.join(root, 'web');
  const inputs = { root, dirs: [web], files: [path.join(root, 'package-lock.json')] };
  fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, 'main.ts'), 'export {};');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const withDir = (name: string) => {
    const dir = path.join(web, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.js'), 'x');
    try { return webSourceHash(inputs); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it.each(['dist', 'node_modules', 'test-results', 'playwright-report', 'e2e', 'dist.tmp-123', 'dist.old-123'])('ignores %s', (name) => {
    expect(withDir(name)).toBe(webSourceHash(inputs));
  });

  it('control: a new source dir, or a changed input file, changes it', () => {
    const before = webSourceHash(inputs);
    expect(withDir('probe')).not.toBe(before);
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"x":1}');
    expect(webSourceHash(inputs)).not.toBe(before);
  });
});

describe('ensureWebBuild failures resolve `failed`, never reject (start() fires it unawaited)', () => {
  const quiet = () => ({ log: vi.fn(), error: vi.fn() });
  const dirs: string[] = [];
  const freshDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webbuild-fail-')); dirs.push(d); return d; };
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    for (const d of dirs) for (const p of [d, `${d}.old-${process.pid}`, `${d}.tmp-${process.pid}`]) fs.rmSync(p, { recursive: true, force: true });
  });
  const previousBuild = () => {
    const dist = freshDir();
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><p>previous-build</p>');
    fs.writeFileSync(path.join(dist, '.source-hash'), 'stale\n');
    return dist;
  };

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
    const dist = previousBuild();
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(`${dist}.tmp-`)) throw Object.assign(new Error('EXDEV: injected rename failure'), { code: 'EXDEV' });
      return realRename(from, to);
    });
    const log = quiet();
    const result = await productionBuild({ log, distDir: dist });
    expect(result).toEqual({ phase: 'failed', error: expect.stringContaining('EXDEV') });
    expect(String(log.error.mock.calls[0][0])).toContain('serving the previous build');
    expect(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')).toContain('previous-build');
    const parent = path.dirname(dist);
    expect(fs.readdirSync(parent).filter((n) => n.startsWith(`${path.basename(dist)}.`))).toEqual([]);

    const app = express();
    app.use(webHandler({ distDir: dist, getState: () => result }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const r = await fetch(`http://127.0.0.1:${port}/`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('previous-build');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }, 120_000);

  it('a swap whose restore fails too reports both errors, the original first, and says no build is served', async () => {
    const dist = previousBuild();
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(`${dist}.tmp-`)) throw Object.assign(new Error('EXDEV: injected move-in failure'), { code: 'EXDEV' });
      if (String(from).startsWith(`${dist}.old-`)) throw Object.assign(new Error('EBUSY: injected restore failure'), { code: 'EBUSY' });
      return realRename(from, to);
    });
    const log = quiet();
    const result = await productionBuild({ log, distDir: dist });
    expect(result.phase).toBe('failed');
    const error = result.error!;
    expect(error).toContain('EXDEV: injected move-in failure');
    expect(error).toContain('EBUSY: injected restore failure');
    expect(error.indexOf('EXDEV')).toBeLessThan(error.indexOf('EBUSY'));
    expect(String(log.error.mock.calls[0][0])).toContain('the UI is unavailable');
    expect(fs.existsSync(path.join(dist, 'index.html'))).toBe(false);
  }, 120_000);

  it('a previous build that cannot be removed after the swap leaves the new build live and `ready`', async () => {
    const dist = previousBuild();
    const old = `${dist}.old-${process.pid}`;
    let movedIn = false;
    const realRename = fs.renameSync;
    const realRm = fs.rmSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      realRename(from, to);
      if (String(from).startsWith(`${dist}.tmp-`)) movedIn = true;
    });
    vi.spyOn(fs, 'rmSync').mockImplementation((p, opts) => {
      if (movedIn && String(p) === old) throw Object.assign(new Error('EBUSY: injected removal failure'), { code: 'EBUSY' });
      return realRm(p, opts);
    });
    const log = quiet();
    const result = await productionBuild({ log, distDir: dist });
    expect(result).toEqual({ phase: 'ready', error: null });
    expect(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')).not.toContain('previous-build');
    expect(log.error.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('EBUSY: injected removal failure')]);
  }, 120_000);
});
