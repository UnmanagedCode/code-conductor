// @vitest-environment node
// The only real Vite build in a gated suite: src/webBuild.ts's ensureWebBuild,
// built once, in beforeAll, into a private dir under os.tmpdir() outside web/
// (webSourceHash walks web/, so an output dir there would change the hash between
// calls). Every dist dir sits in a parent of its own, because ensureWebBuild's
// leftover sweep reads that parent. The failure paths run on the injected
// builder. Nothing here writes under web/.
// The build runs as a child process that sets NODE_ENV=production itself, so the
// bundle checked here is the one the server ships, whatever Vitest's NODE_ENV.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import {
  ensureWebBuild, runViteBuild, stageWebBuild, webHandler, webInputs, webSourceHash, WEB_ROOT, type WebBuilder, type WebState,
} from '../../src/webBuild.ts';

const quiet = () => ({ log: vi.fn(), error: vi.fn() });
const builder = (label: string) => {
  const fn = vi.fn<WebBuilder>(async (outDir) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), `<p>${label}</p>`);
  });
  return fn;
};

const distParent = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webbuild-'));
const distDir = path.join(distParent, 'dist');
const log = { log: vi.fn(), error: vi.fn() };
let first: WebState;

beforeAll(async () => {
  first = await ensureWebBuild({ log, distDir });
}, 120_000);

afterAll(() => {
  fs.rmSync(distParent, { recursive: true, force: true });
});

describe('ensureWebBuild', () => {
  it('builds, and stamps the output with the source hash', () => {
    expect(log.error).not.toHaveBeenCalled();
    expect(first).toEqual({ phase: 'ready', error: null });
    expect(fs.readFileSync(path.join(distDir, '.source-hash'), 'utf8').trim()).toBe(webSourceHash());
  });

  // Hashes all of web/ + shared/: far slower under load than idle.
  it('does not rebuild when the sources are unchanged', { timeout: 30_000 }, async () => {
    const index = path.join(distDir, 'index.html');
    const mtime = fs.statSync(index).mtimeMs;
    log.log.mockClear();
    expect(await ensureWebBuild({ log, distDir })).toEqual({ phase: 'ready', error: null });
    expect(log.log).not.toHaveBeenCalled();
    expect(fs.statSync(index).mtimeMs).toBe(mtime);
  });

  it('sweeps <dist>[.next].tmp-<pid> / .old-<pid> leftovers of dead processes, never a live one\'s', { timeout: 30_000 }, async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const sibling = (suffix: string) => { const d = `${distDir}${suffix}`; fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'x'), 'x'); return d; };
    const swept = [sibling(`.tmp-${dead}`), sibling(`.old-${dead}`), sibling(`.next.tmp-${dead}`), sibling(`.next.old-${dead}`)];
    const kept = [
      sibling(`.tmp-${process.ppid}`), sibling(`.old-${process.ppid}`), sibling(`.tmp-${process.pid}`), sibling('.tmp-notapid'),
      sibling(`.next.tmp-${process.ppid}`), sibling(`.other.tmp-${dead}`),
    ];
    const build = builder('never');
    try {
      expect(await ensureWebBuild({ log, distDir, build })).toEqual({ phase: 'ready', error: null });
      expect(build).not.toHaveBeenCalled();
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
    // The build's own output reaches the server log; none of it is the size warning.
    expect(log.log.mock.calls.map((c) => String(c[0])).filter((w) => /chunks are larger than/.test(w))).toEqual([]);
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
    // Invariant: each file the build emits (document, manifest, icons, chunks) is answered 200 with a body, so nothing the page references is missing, and the manifest and icons with the content type a browser needs.
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
      // The types a browser needs to use the manifest and the icons.
      const TYPES: Record<string, RegExp> = { '.webmanifest': /^application\/manifest\+json\b/, '.svg': /^image\/svg\+xml\b/, '.png': /^image\/png\b/ };
      const bad: string[] = [];
      const typed: string[] = [];
      for (const f of ['', ...files]) {
        const r = await fetch(`${base}/${f}`);
        const body = await r.arrayBuffer();
        if (r.status !== 200 || body.byteLength === 0) bad.push(`${f || '/'} -> ${r.status}, ${body.byteLength} bytes`);
        const want = TYPES[path.extname(f)];
        if (want) {
          typed.push(path.extname(f));
          const type = r.headers.get('content-type') ?? '';
          if (!want.test(type)) bad.push(`${f} -> content-type ${type}`);
        }
      }
      expect(bad).toEqual([]);
      expect(new Set(typed), 'fixture check: the build ships a manifest, SVGs and PNGs').toEqual(new Set(Object.keys(TYPES)));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('webSourceHash over a fixture root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webhash-'));
  const web = path.join(root, 'web');
  const lock = path.join(root, 'node_modules', '.package-lock.json');
  const inputs = { root, dirs: [web], files: [lock] };
  fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, 'main.ts'), 'export {};');
  fs.mkdirSync(path.dirname(lock));
  fs.writeFileSync(lock, '{}');
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const withDir = (name: string) => {
    const dir = path.join(web, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.js'), 'x');
    try { return webSourceHash(inputs); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it.each([
    'dist', 'node_modules', 'test-results', 'playwright-report', 'e2e', 'dist.tmp-123', 'dist.old-123',
    'dist.next', 'dist.next.tmp-123', 'dist.next.old-123',
  ])('ignores %s', (name) => {
    expect(withDir(name)).toBe(webSourceHash(inputs));
  });

  it('control: a new source dir, or a changed input file, changes it', () => {
    const before = webSourceHash(inputs);
    expect(withDir('probe')).not.toBe(before);
    expect(withDir('distx')).not.toBe(before);
    fs.writeFileSync(lock, '{"x":1}');
    expect(webSourceHash(inputs)).not.toBe(before);
  });
});

describe('the default inputs (webInputs) over a fixture checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webinputs-'));
  const hidden = path.join(root, 'node_modules', '.package-lock.json');
  for (const [rel, body] of [['web/main.ts', 'export {};'], ['shared/a.ts', 'export {};'], ['node_modules/.package-lock.json', '{}']]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('the running checkout hashes with the inputs webInputs names for its root', () => {
    expect(webSourceHash()).toBe(webSourceHash(webInputs(path.dirname(WEB_ROOT))));
  });

  it("a change to the installed tree's hidden lockfile changes the hash; a root package-lock.json is not an input", () => {
    const before = webSourceHash(webInputs(root));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    expect(webSourceHash(webInputs(root))).toBe(before);
    fs.writeFileSync(hidden, '{"packages":{"node_modules/vite":{"version":"8.3.4"}}}');
    expect(webSourceHash(webInputs(root))).not.toBe(before);
  });

  it('web/ and shared/ are inputs', () => {
    const before = webSourceHash(webInputs(root));
    fs.writeFileSync(path.join(root, 'shared', 'a.ts'), 'export const x = 1;');
    const afterShared = webSourceHash(webInputs(root));
    expect(afterShared).not.toBe(before);
    fs.writeFileSync(path.join(root, 'web', 'main.ts'), 'export const y = 1;');
    expect(webSourceHash(webInputs(root))).not.toBe(afterShared);
  });
});

describe('ensureWebBuild failures resolve `failed`, never reject (start() fires it unawaited)', () => {
  const parents: string[] = [];
  const freshDir = () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webbuild-fail-'));
    parents.push(parent);
    return path.join(parent, 'dist');
  };
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => { for (const p of parents) fs.rmSync(p, { recursive: true, force: true }); });
  const previousBuild = () => {
    const dist = freshDir();
    fs.mkdirSync(dist);
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
    const build = builder('never');
    await expect(ensureWebBuild({ log, distDir: freshDir(), build })).resolves.toEqual({ phase: 'failed', error: expect.stringContaining('EACCES') });
    expect(log.error).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
  });

  it('a swap that fails keeps the previous build in place and served', async () => {
    const dist = previousBuild();
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(`${dist}.tmp-`)) throw Object.assign(new Error('EXDEV: injected rename failure'), { code: 'EXDEV' });
      return realRename(from, to);
    });
    const log = quiet();
    const result = await ensureWebBuild({ log, distDir: dist, build: builder('new-build') });
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
  });

  it('a swap whose restore fails too reports both errors, the original first, and says no build is served', async () => {
    const dist = previousBuild();
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(`${dist}.tmp-`)) throw Object.assign(new Error('EXDEV: injected move-in failure'), { code: 'EXDEV' });
      if (String(from).startsWith(`${dist}.old-`)) throw Object.assign(new Error('EBUSY: injected restore failure'), { code: 'EBUSY' });
      return realRename(from, to);
    });
    const log = quiet();
    const result = await ensureWebBuild({ log, distDir: dist, build: builder('new-build') });
    expect(result.phase).toBe('failed');
    const error = result.error!;
    expect(error).toContain('EXDEV: injected move-in failure');
    expect(error).toContain('EBUSY: injected restore failure');
    expect(error.indexOf('EXDEV')).toBeLessThan(error.indexOf('EBUSY'));
    expect(String(log.error.mock.calls[0][0])).toContain('the UI is unavailable');
    expect(fs.existsSync(path.join(dist, 'index.html'))).toBe(false);
  });

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
    const result = await ensureWebBuild({ log, distDir: dist, build: builder('new-build') });
    expect(result).toEqual({ phase: 'ready', error: null });
    expect(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')).toContain('new-build');
    expect(log.error.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('EBUSY: injected removal failure')]);
  });
});

// Staging (the old process, before a relaunch) and adoption (the new one, at
// boot), with the builder injected: each fake build writes an index.html naming
// itself, so which build is served is read off the file.
describe('staging a build before a relaunch, and adopting it at boot', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const parentDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-webstage-')); dirs.push(d); return d; };
  const failing = () => vi.fn<WebBuilder>(async (outDir) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'partial.js'), 'x');
    throw Object.assign(new Error('vite build failed (exit 1)'), { tail: 'error: Unexpected token' });
  });
  const stamped = (dir: string, label: string, hash: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), `<p>${label}</p>`);
    fs.writeFileSync(path.join(dir, '.source-hash'), `${hash}\n`);
  };
  const served = (dir: string) => fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const siblings = (dir: string) => fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(`${path.basename(dir)}.`)).sort();

  it('stageWebBuild builds into <dist>.next, stamped with the source hash, and leaves <dist> as it was', async () => {
    const dist = path.join(parentDir(), 'dist');
    stamped(dist, 'serving', 'stale');
    const build = builder('staged');
    const chunks: string[] = [];
    expect(await stageWebBuild({ distDir: dist, build, onChunk: (t) => chunks.push(t) })).toEqual({ staged: true });
    expect(build).toHaveBeenCalledOnce();
    expect(build.mock.calls[0][1].onChunk).toBeTypeOf('function');
    expect(served(`${dist}.next`)).toContain('staged');
    expect(fs.readFileSync(path.join(`${dist}.next`, '.source-hash'), 'utf8').trim()).toBe(webSourceHash());
    expect(served(dist)).toContain('serving');
    expect(fs.readFileSync(path.join(dist, '.source-hash'), 'utf8').trim()).toBe('stale');
    expect(siblings(dist)).toEqual(['dist.next']);
  });

  it('stageWebBuild builds nothing when <dist> is already current, or when the staged build is', async () => {
    const current = path.join(parentDir(), 'dist');
    stamped(current, 'serving', webSourceHash());
    const none = builder('x');
    expect(await stageWebBuild({ distDir: current, build: none })).toEqual({ staged: false });
    expect(fs.existsSync(`${current}.next`)).toBe(false);

    const behind = path.join(parentDir(), 'dist');
    stamped(behind, 'serving', 'stale');
    stamped(`${behind}.next`, 'already staged', webSourceHash());
    expect(await stageWebBuild({ distDir: behind, build: none })).toEqual({ staged: true });
    expect(none).not.toHaveBeenCalled();
    expect(served(`${behind}.next`)).toContain('already staged');
  });

  it('stageWebBuild replaces a staged build whose stamp is stale', async () => {
    const dist = path.join(parentDir(), 'dist');
    stamped(`${dist}.next`, 'old staged', 'stale');
    const build = builder('restaged');
    expect(await stageWebBuild({ distDir: dist, build })).toEqual({ staged: true });
    expect(build).toHaveBeenCalledOnce();
    expect(served(`${dist}.next`)).toContain('restaged');
  });

  it('a failed stage throws with the build\'s tail, leaves no staged or tmp dir, and never touches what is served', async () => {
    const dist = path.join(parentDir(), 'dist');
    stamped(dist, 'serving', 'stale');
    await expect(stageWebBuild({ distDir: dist, build: failing() }))
      .rejects.toMatchObject({ message: 'vite build failed (exit 1)', tail: 'error: Unexpected token' });
    expect(siblings(dist)).toEqual([]);
    expect(served(dist)).toContain('serving');
    // The module's serving state is not the stage's: the UI route still answers as it did, not with the stage's failure.
    const app = express();
    app.use(webHandler({ distDir: parentDir() }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
      expect(await r.text()).not.toContain('failed to build');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  it('ensureWebBuild adopts a staged build whose stamp matches, without building', async () => {
    const dist = path.join(parentDir(), 'dist');
    stamped(dist, 'previous', 'stale');
    stamped(`${dist}.next`, 'staged before restart', webSourceHash());
    const build = builder('rebuilt');
    const log = quiet();
    expect(await ensureWebBuild({ log, distDir: dist, build })).toEqual({ phase: 'ready', error: null });
    expect(build).not.toHaveBeenCalled();
    expect(served(dist)).toContain('staged before restart');
    expect(siblings(dist)).toEqual([]);
    expect(log.log.mock.calls.map((c) => String(c[0]))).toEqual(['web: adopted the build staged before restart']);
  });

  it('ensureWebBuild discards a staged build whose stamp does not match and builds <dist>', async () => {
    const dist = path.join(parentDir(), 'dist');
    stamped(`${dist}.next`, 'stale staged', 'stale');
    const build = builder('rebuilt');
    expect(await ensureWebBuild({ log: quiet(), distDir: dist, build })).toEqual({ phase: 'ready', error: null });
    expect(build).toHaveBeenCalledOnce();
    expect(served(dist)).toContain('rebuilt');
    expect(fs.readFileSync(path.join(dist, '.source-hash'), 'utf8').trim()).toBe(webSourceHash());
    expect(siblings(dist)).toEqual([]);
  });

  it('ensureWebBuild leaves a current <dist> and a stale staged dir alone', async () => {
    const dist = path.join(parentDir(), 'dist');
    stamped(dist, 'current', webSourceHash());
    stamped(`${dist}.next`, 'stale staged', 'stale');
    const build = builder('x');
    expect(await ensureWebBuild({ log: quiet(), distDir: dist, build })).toEqual({ phase: 'ready', error: null });
    expect(build).not.toHaveBeenCalled();
    expect(served(dist)).toContain('current');
  });

  it('a failed boot build names the dependency drift when node_modules does not satisfy package.json, and only then', async () => {
    const log = quiet();
    const drifted = await ensureWebBuild({ log, distDir: path.join(parentDir(), 'dist'), build: failing(), drift: () => ({ reason: 'node_modules/vite missing' }) });
    expect(drifted.phase).toBe('failed');
    expect(drifted.error).toContain('vite build failed (exit 1)');
    expect(drifted.error).toContain('error: Unexpected token');
    expect(drifted.error).toContain('node_modules does not satisfy package.json: node_modules/vite missing; run npm install');
    expect(String(log.error.mock.calls[0][0])).toContain('node_modules/vite missing');

    const inSync = await ensureWebBuild({ log: quiet(), distDir: path.join(parentDir(), 'dist'), build: failing(), drift: () => null });
    expect(inSync.error).not.toContain('does not satisfy');
  });
});

describe('runViteBuild', () => {
  const roots: string[] = [];
  afterAll(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });
  const root = (viteJs?: string) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vitebin-'));
    roots.push(r);
    if (viteJs !== undefined) {
      fs.mkdirSync(path.join(r, 'node_modules', 'vite', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(r, 'node_modules', 'vite', 'bin', 'vite.js'), viteJs);
    }
    return r;
  };

  it('refuses with "vite is not installed" when node_modules/vite/bin/vite.js is missing', async () => {
    await expect(runViteBuild(path.join(root(), 'out'), { root: root() }))
      .rejects.toThrow('vite is not installed (node_modules/vite/bin/vite.js missing) — run npm install');
  });

  it('runs vite.js under this node, in the repo root, with the build argv and NODE_ENV=production; streams its output', async () => {
    const r = root('console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env.NODE_ENV }));');
    const out = path.join(r, 'out');
    let text = '';
    await runViteBuild(out, { root: r, onChunk: (t) => { text += t; } });
    expect(JSON.parse(text)).toEqual({
      argv: ['build', '--config', 'web/vite.config.ts', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'],
      cwd: fs.realpathSync(r),
      env: 'production',
    });
  });

  it('a non-zero exit throws naming the code, with the output tail', async () => {
    const r = root('console.error("[vite]: Rollup failed to resolve import"); process.exit(2);');
    await expect(runViteBuild(path.join(r, 'out'), { root: r }))
      .rejects.toMatchObject({ message: 'vite build failed (exit 2)', tail: expect.stringContaining('Rollup failed to resolve import') });
  });
});
