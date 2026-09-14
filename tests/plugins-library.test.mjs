import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPluginLibrary } from '../src/plugins/library.ts';
import { orchStoreRoot, adoptProject, listProjects, externalDir } from '../src/projects.ts';
import { makePluginRoot } from './plugin-helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

const run = promisify(execFile);
async function git(cwd, ...args) { await run('git', ['-C', cwd, ...args]); }

async function rejectsWithStatus(promise, statusCode) {
  try { await promise; }
  catch (e) { assert.equal(e.statusCode, statusCode, `expected ${statusCode}, got ${e.statusCode}: ${e.message}`); return e; }
  assert.fail(`expected rejection with statusCode ${statusCode}`);
}

function libraryDir() {
  return path.join(orchStoreRoot(), 'plugins', 'library');
}

async function dropLibraryEntry(name, entry) {
  const dir = libraryDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(entry));
}

test('list(): default code-share entry present with no library dir', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    const { entries: rows } = await lib.list();
    assert.equal(rows.length, 8);
    assert.equal(rows[0].id, 'code-share');
    assert.equal(rows[0].repo, 'https://github.com/UnmanagedCode/code-share');
    assert.equal(rows[0].installed, false);
    assert.equal(rows[0].installedAs, null);
  } finally {
    await env.restore();
  }
});

test('list(): code-playwright is a built-in entry alongside code-share, with its postClone/postPull command', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    const { entries: rows } = await lib.list();
    const ids = rows.map(r => r.id).sort();
    assert.deepEqual(ids, ['code-dialectic', 'code-hub', 'code-kanban', 'code-karpathy-wiki', 'code-mutant', 'code-playwright', 'code-share', 'code-system']);
    const cp = rows.find(r => r.id === 'code-playwright');
    assert.equal(cp.repo, 'https://github.com/UnmanagedCode/code-playwright');
    assert.equal(cp.postClone, 'bash install.sh');
    assert.equal(cp.postPull, 'bash install.sh');
    const cs = rows.find(r => r.id === 'code-share');
    assert.equal(cs.postClone, undefined, 'code-share has no post-hook by default');
  } finally {
    await env.restore();
  }
});

test('list(): a dropped file adds an entry; malformed files are skipped, not fatal', async () => {
  const env = await makePluginRoot();
  try {
    await dropLibraryEntry('extra.json', { id: 'extra-plugin', name: 'Extra', description: 'desc', repo: 'https://example.com/org/extra' });
    await fs.mkdir(libraryDir(), { recursive: true });
    await fs.writeFile(path.join(libraryDir(), 'broken.json'), '{ not json'); // truly malformed, not a stringified string
    await dropLibraryEntry('incomplete.json', { id: 'nope' }); // missing name/repo
    await fs.writeFile(path.join(libraryDir(), 'not-a-manifest.txt'), 'ignored, wrong extension');

    const lib = createPluginLibrary();
    const { entries: rows, skipped } = await lib.list();
    const ids = rows.map(r => r.id).sort();
    assert.deepEqual(ids, ['code-dialectic', 'code-hub', 'code-kanban', 'code-karpathy-wiki', 'code-mutant', 'code-playwright', 'code-share', 'code-system', 'extra-plugin']);

    // A silently-dropped drop-in is indistinguishable from one never written, so
    // both per-file skip reasons are reported by name.
    assert.deepEqual(skipped.map(s => s.file).sort(), ['broken.json', 'incomplete.json']);
    assert.ok(!skipped.some(s => s.file === 'not-a-manifest.txt'),
      'a wrong-extension file is a deliberate ignore, NOT a skip');
    assert.ok(skipped.every(s => s.reason && s.reason.length > 0), 'every skip carries a reason');
    assert.match(skipped.find(s => s.file === 'incomplete.json').reason, /id\/name\/repo/);
  } finally {
    await env.restore();
  }
});

// The audit fenced off the JUSTIFIED logged degradations, and an unreadable
// library DIRECTORY is one of them: it has no per-file identity to report, and
// the built-in catalog still serves. This pins that it was NOT swept into the
// notice channel along with the two per-file skips above.
test('list(): an unreadable library directory stays a silent logged degradation', async () => {
  const env = await makePluginRoot();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    // A FILE where the library dir belongs ⇒ readdir fails ENOTDIR (non-ENOENT).
    await fs.mkdir(path.dirname(libraryDir()), { recursive: true });
    await fs.writeFile(libraryDir(), 'not a directory');

    const lib = createPluginLibrary();
    const { entries, skipped } = await lib.list();
    assert.ok(entries.length > 0, 'the built-in entries still serve');
    assert.deepEqual(skipped, [], 'a directory-level failure is NOT reported per-file');
    assert.ok(warns.some(w => w.includes('failed to read library dir')),
      'it stays a logged degradation, exactly as before');
  } finally {
    console.warn = origWarn;
    await env.restore();
  }
});

test('list(): a dropped file whose id matches the built-in overrides it', async () => {
  const env = await makePluginRoot();
  try {
    await dropLibraryEntry('code-share.json', { id: 'code-share', name: 'Custom Code Share', repo: 'https://example.com/fork/code-share' });
    const lib = createPluginLibrary();
    const { entries: rows } = await lib.list();
    assert.equal(rows.length, 8);
    assert.equal(rows[0].name, 'Custom Code Share');
    assert.equal(rows[0].repo, 'https://example.com/fork/code-share');
  } finally {
    await env.restore();
  }
});

test('list(): installed flips true once the derived target dir exists', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-share');
    const lib = createPluginLibrary();
    const { entries: rows } = await lib.list();
    assert.equal(rows[0].installed, true);
    assert.equal(rows[0].installedAs, 'code-share');
  } finally {
    await env.restore();
  }
});

test('list(): installed but not a git repo -> updateAvailable false, never throws', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-share'); // plain dir, not a git repo
    const lib = createPluginLibrary();
    const { entries: rows } = await lib.list();
    assert.equal(rows[0].installed, true);
    assert.equal(rows[0].updateAvailable, false);
    assert.equal(rows[0].behind, null);
  } finally {
    await env.restore();
  }
});

test('list(): installed git repo with no remote configured -> updateAvailable false, never throws', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addProject('code-share');
    await git(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(dir, 'config', 'user.email', 'test@test');
    await git(dir, 'config', 'user.name', 'test');
    await fs.writeFile(path.join(dir, 'file.txt'), 'v1');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'v1');

    const lib = createPluginLibrary();
    const { entries: rows } = await lib.list();
    assert.equal(rows[0].installed, true);
    assert.equal(rows[0].updateAvailable, false);
    assert.equal(rows[0].behind, null);
  } finally {
    await env.restore();
  }
});

test('list(): installed + up to date with origin -> updateAvailable false, behind 0', async () => {
  const env = await makePluginRoot();
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-remote-'));
  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-seed-'));
  try {
    await git(remoteDir, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
    await git(seedDir, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(seedDir, 'config', 'user.email', 'test@test');
    await git(seedDir, 'config', 'user.name', 'test');
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v1');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v1');
    await git(seedDir, 'remote', 'add', 'origin', remoteDir);
    await git(seedDir, 'push', '-q', 'origin', 'main');

    await git(env.root, 'clone', '-q', remoteDir, 'code-share');

    const lib = createPluginLibrary();
    const { entries: rows } = await lib.list();
    assert.equal(rows[0].installed, true);
    assert.equal(rows[0].updateAvailable, false);
    assert.equal(rows[0].behind, 0);
  } finally {
    await env.restore();
    await fs.rm(remoteDir, { recursive: true, force: true });
    await fs.rm(seedDir, { recursive: true, force: true });
  }
});

test('list(): installed + behind origin -> updateAvailable true, behind > 0 (fetches before comparing)', async () => {
  const env = await makePluginRoot();
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-remote-'));
  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-seed-'));
  try {
    await git(remoteDir, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
    await git(seedDir, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(seedDir, 'config', 'user.email', 'test@test');
    await git(seedDir, 'config', 'user.name', 'test');
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v1');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v1');
    await git(seedDir, 'remote', 'add', 'origin', remoteDir);
    await git(seedDir, 'push', '-q', 'origin', 'main');

    await git(env.root, 'clone', '-q', remoteDir, 'code-share');

    // A new commit lands upstream after the install-time clone — list()
    // must fetch on its own (its comparison-only helper reads cached refs)
    // to see this, not just report stale local knowledge.
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v2');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v2');
    await git(seedDir, 'push', '-q', 'origin', 'main');

    const lib = createPluginLibrary();
    const { entries: rows } = await lib.list();
    assert.equal(rows[0].installed, true);
    assert.equal(rows[0].updateAvailable, true);
    assert.equal(rows[0].behind, 1);
  } finally {
    await env.restore();
    await fs.rm(remoteDir, { recursive: true, force: true });
    await fs.rm(seedDir, { recursive: true, force: true });
  }
});

test('install(): unknown id -> 404', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.install('nope'), 404);
  } finally {
    await env.restore();
  }
});

test('install(): invalid/disallowed repo URL scheme -> 400', async () => {
  const env = await makePluginRoot();
  try {
    await dropLibraryEntry('bad.json', { id: 'bad', name: 'Bad', repo: 'ftp://example.com/org/bad' });
    await dropLibraryEntry('worse.json', { id: 'worse', name: 'Worse', repo: 'not a url at all' });
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.install('bad'), 400);
    await rejectsWithStatus(lib.install('worse'), 400);
  } finally {
    await env.restore();
  }
});

test('install(): already-installed target dir -> 409', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-share');
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.install('code-share'), 409);
  } finally {
    await env.restore();
  }
});

test('install(): a name held by an ADOPTED project -> 409 before any clone', async () => {
  // The gate's whole reason for going through resolveProjectDir rather than an
  // in-root fs.stat: an adopted project holds its name without occupying
  // `<projectsRoot>/<name>`, so an in-root-only probe sees "free", clones over
  // it, and mints a SECOND record for one project name — two store entries and
  // one shared encodeCwd session dir.
  const env = await makePluginRoot();
  const outside = await mkdtemp('adopted-cs-');
  try {
    await git(outside, 'init', '-q', '-b', 'main');
    // `code-share`'s repo URL derives the project name `code-share`.
    const adopted = await adoptProject('code-share', outside);
    assert.equal(adopted.ok, true, JSON.stringify(adopted));

    const cloneCalls = [];
    let validated = 0;
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => { cloneCalls.push({ url, destDir }); return { code: 0, stdout: '', stderr: '' }; },
    });
    await rejectsWithStatus(lib.install('code-share', { onValidated: () => { validated++; } }), 409);

    // Refused during validation — nothing was cloned and the streaming switch
    // never fired, so no partial dir can be left behind either.
    assert.deepEqual(cloneCalls, [], 'the clone must not run');
    assert.equal(validated, 0, 'onValidated never fires on a refused install');

    // And exactly ONE record still answers to that name: the adopted one.
    const rows = (await listProjects()).filter(p => p.name === 'code-share');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external, true);
    assert.equal(rows[0].path, await fs.realpath(outside));
    await assert.rejects(() => fs.stat(path.join(env.root, 'code-share')),
      'no in-root directory was created for a name already held');
    assert.deepEqual(await fs.readdir(externalDir()), ['code-share']);
  } finally {
    await rmrf(outside);
    await env.restore();
  }
});

test('install(): happy path clones (fake impl), rescans, and enables the discovered plugin by default', async () => {
  const env = await makePluginRoot();
  try {
    let rescanned = 0;
    const enabled = [];
    const stubHost = {
      rescan: async () => { rescanned++; },
      list: async () => [{ id: 'code-share', project: 'code-share', state: 'discovered' }],
      enable: async (id) => { enabled.push(id); },
    };
    const cloneCalls = [];
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _cloneImpl: async (url, destDir) => {
        cloneCalls.push({ url, destDir });
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(path.join(destDir, 'marker.txt'), 'cloned');
        return { code: 0, stdout: 'Cloning...', stderr: '' };
      },
    });
    const result = await lib.install('code-share');
    assert.equal(result.name, 'code-share');
    assert.equal(cloneCalls.length, 1);
    assert.equal(cloneCalls[0].url, 'https://github.com/UnmanagedCode/code-share');
    assert.ok((await fs.stat(path.join(env.root, 'code-share'))).isDirectory());
    assert.equal(rescanned, 1);
    assert.deepEqual(enabled, ['code-share'], 'the freshly discovered plugin is enabled by default');
    assert.equal(result.postClone, null, 'code-share has no postClone configured');

    const { entries: rows } = await lib.list();
    assert.equal(rows[0].installed, true);
  } finally {
    await env.restore();
  }
});

test('install(): does not enable a plugin whose manifest is invalid/undiscoverable', async () => {
  const env = await makePluginRoot();
  try {
    const enabled = [];
    const stubHost = {
      rescan: async () => {},
      list: async () => [{ id: 'code-share', project: 'code-share', state: 'invalid' }],
      enable: async (id) => { enabled.push(id); },
    };
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await lib.install('code-share');
    assert.deepEqual(enabled, [], 'a non-discovered (invalid/conflict) plugin is left disabled');
  } finally {
    await env.restore();
  }
});

test('install(): onValidated fires once, before the clone starts; onChunk streams clone + hook output', async () => {
  const env = await makePluginRoot();
  try {
    const events = [];
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir, { onChunk } = {}) => {
        await fs.mkdir(destDir, { recursive: true });
        onChunk?.('Cloning...\n');
        onChunk?.('done.\n');
        return { code: 0, stdout: '', stderr: '' };
      },
      _runHookImpl: async (command, cwd, { onChunk } = {}) => {
        onChunk?.('deps installed\n');
        return { code: 0, output: 'deps installed' };
      },
    });
    const result = await lib.install('code-playwright', {
      onValidated: () => events.push('validated'),
      onChunk: (phase, text) => events.push(`${phase}:${text.trim()}`),
    });
    assert.equal(result.name, 'code-playwright');
    assert.deepEqual(events, ['validated', 'clone:Cloning...', 'clone:done.', 'hook:deps installed']);
  } finally {
    await env.restore();
  }
});

test('install(): onValidated never fires when validation rejects (unknown id)', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    let validated = false;
    await rejectsWithStatus(lib.install('nope', { onValidated: () => { validated = true; } }), 404);
    assert.equal(validated, false);
  } finally {
    await env.restore();
  }
});

test('install(): clone failure -> 502 with stderr tail, partial dir cleaned up', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true }); // partial clone leaves a dir behind
        return { code: 128, stdout: '', stderr: 'fatal: could not read from remote repository\nboom' };
      },
    });
    const e = await rejectsWithStatus(lib.install('code-share'), 502);
    assert.match(e.tail, /boom/);
    await assert.rejects(fs.stat(path.join(env.root, 'code-share')), { code: 'ENOENT' });
  } finally {
    await env.restore();
  }
});

test('install(): runs postClone after a successful clone + rescan', async () => {
  const env = await makePluginRoot();
  try {
    let rescanned = 0;
    const stubHost = { rescan: async () => { rescanned++; } };
    const hookCalls = [];
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
      _runHookImpl: async (command, cwd) => {
        hookCalls.push({ command, cwd });
        return { code: 0, output: 'deps installed' };
      },
    });
    const result = await lib.install('code-playwright');
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].command, 'bash install.sh');
    assert.equal(hookCalls[0].cwd, path.join(env.root, 'code-playwright'));
    assert.deepEqual(result.postClone, { ran: true, ok: true, code: 0, tail: 'deps installed' });
    assert.equal(rescanned, 1, 'rescan happens before postClone, per the documented order');
  } finally {
    await env.restore();
  }
});

test('install(): postClone failure keeps the clone on disk and resolves (not rejects) with ok:false + tail', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
      _runHookImpl: async () => ({ code: 1, output: 'npm ERR! network timeout' }),
    });
    const result = await lib.install('code-playwright');
    assert.equal(result.postClone.ran, true);
    assert.equal(result.postClone.ok, false);
    assert.equal(result.postClone.code, 1);
    assert.match(result.postClone.tail, /network timeout/);
    assert.ok((await fs.stat(path.join(env.root, 'code-playwright'))).isDirectory(), 'clone was NOT removed');
  } finally {
    await env.restore();
  }
});

test('update(): unknown library id -> 404', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.update('nope'), 404);
  } finally {
    await env.restore();
  }
});

test('update(): not installed -> 404', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    await rejectsWithStatus(lib.update('code-share'), 404);
  } finally {
    await env.restore();
  }
});

test('update(): onValidated fires once, before the pull starts; onChunk streams pull + hook output', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-playwright');
    const events = [];
    const lib = createPluginLibrary({
      _pullImpl: async (cwd, { onChunk } = {}) => {
        onChunk?.('Updating...\n');
        onChunk?.('Fast-forward\n');
        return { code: 0, stdout: '', stderr: '' };
      },
      _runHookImpl: async (command, cwd, { onChunk } = {}) => {
        onChunk?.('deps installed\n');
        return { code: 0, output: 'deps installed' };
      },
    });
    const result = await lib.update('code-playwright', {
      onValidated: () => events.push('validated'),
      onChunk: (phase, text) => events.push(`${phase}:${text.trim()}`),
    });
    assert.equal(result.name, 'code-playwright');
    assert.deepEqual(events, ['validated', 'pull:Updating...', 'pull:Fast-forward', 'hook:deps installed']);
  } finally {
    await env.restore();
  }
});

test('update(): onValidated never fires when validation rejects (not installed)', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary();
    let validated = false;
    await rejectsWithStatus(lib.update('code-share', { onValidated: () => { validated = true; } }), 404);
    assert.equal(validated, false);
  } finally {
    await env.restore();
  }
});

test('update(): pull failure (not a git repo) -> 502 with tail; postPull never runs', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-share'); // plain dir, not a git repo
    const hookCalls = [];
    const lib = createPluginLibrary({
      _runHookImpl: async (command, cwd) => { hookCalls.push({ command, cwd }); return { code: 0, output: '' }; },
    });
    const e = await rejectsWithStatus(lib.update('code-share'), 502);
    assert.match(e.tail, /not a git repository/i);
    assert.equal(hookCalls.length, 0);
  } finally {
    await env.restore();
  }
});

test('update(): pulls new commits, runs postPull, and triggers a rescan', async () => {
  const env = await makePluginRoot();
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-remote-'));
  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-seed-'));
  try {
    await git(remoteDir, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
    await git(seedDir, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(seedDir, 'config', 'user.email', 'test@test');
    await git(seedDir, 'config', 'user.name', 'test');
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v1');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v1');
    await git(seedDir, 'remote', 'add', 'origin', remoteDir);
    await git(seedDir, 'push', '-q', 'origin', 'main');

    await git(env.root, 'clone', '-q', remoteDir, 'code-x');

    // A new commit lands upstream after the install-time clone.
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v2');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v2');
    await git(seedDir, 'push', '-q', 'origin', 'main');

    await dropLibraryEntry('code-x.json', {
      id: 'code-x', name: 'Code X', repo: 'https://example.com/org/code-x', postPull: 'echo hi',
    });

    let rescanned = 0;
    const stubHost = { rescan: async () => { rescanned++; }, list: async () => [], restart: async () => {} };
    const hookCalls = [];
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _runHookImpl: async (command, cwd) => { hookCalls.push({ command, cwd }); return { code: 0, output: 'ran' }; },
    });

    const result = await lib.update('code-x');
    assert.equal(result.name, 'code-x');
    assert.deepEqual(result.postPull, { ran: true, ok: true, code: 0, tail: 'ran' });
    assert.equal(result.restarted, null, 'no running rows for this project ⇒ nothing to restart');
    assert.equal(rescanned, 1);
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].command, 'echo hi');
    assert.equal(hookCalls[0].cwd, path.join(env.root, 'code-x'));

    const content = await fs.readFile(path.join(env.root, 'code-x', 'file.txt'), 'utf8');
    assert.equal(content, 'v2', 'pull actually fast-forwarded');
  } finally {
    await env.restore();
    await fs.rm(remoteDir, { recursive: true, force: true });
    await fs.rm(seedDir, { recursive: true, force: true });
  }
});

test('update(): a running plugin backend gets restarted; a restart failure is soft — update still resolves', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-x');
    await dropLibraryEntry('code-x.json', {
      id: 'code-x', name: 'Code X', repo: 'https://example.com/org/code-x', postPull: 'echo hi',
    });
    const stubHost = {
      rescan: async () => {},
      list: async () => [{ id: 'code-x-backend', project: 'code-x', state: 'ready' }],
      restart: async () => { throw new Error('boom restart'); },
    };
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _pullImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
      _runHookImpl: async (command, cwd) => ({ code: 0, output: 'ran' }),
    });

    const result = await lib.update('code-x'); // must resolve, not reject
    assert.deepEqual(result.postPull, { ran: true, ok: true, code: 0, tail: 'ran' }, 'postPull unaffected by the restart failure');
    assert.equal(result.restarted.ok, false);
    assert.deepEqual(result.restarted.ids, []);
    assert.match(result.restarted.error, /code-x-backend: boom restart/);
  } finally {
    await env.restore();
  }
});

test('update(): a host.list() failure is surfaced as a restart failure, never swallowed as "nothing was running"', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-x');
    await dropLibraryEntry('code-x.json', { id: 'code-x', name: 'Code X', repo: 'https://example.com/org/code-x' });
    const stubHost = {
      rescan: async () => {},
      list: async () => { throw new Error('boom list'); },
      restart: async () => {},
    };
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _pullImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });

    const result = await lib.update('code-x'); // must resolve, not reject
    // Distinct from the plain "nothing was running" null: the caller cannot
    // tell whether a backend was up without a working list() call, so a
    // list() failure must surface as its own {ok:false} shape, not collapse
    // into null.
    assert.notEqual(result.restarted, null);
    assert.deepEqual(result.restarted, { ids: [], ok: false, error: 'boom list' });
  } finally {
    await env.restore();
  }
});

test('update(): a backend still in \'starting\' is restarted too, not just \'ready\'', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-x');
    await dropLibraryEntry('code-x.json', { id: 'code-x', name: 'Code X', repo: 'https://example.com/org/code-x' });
    const restartCalls = [];
    const stubHost = {
      rescan: async () => {},
      list: async () => [{ id: 'code-x-backend', project: 'code-x', state: 'starting' }],
      restart: async (id) => { restartCalls.push(id); },
    };
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _pullImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });

    const result = await lib.update('code-x');
    assert.deepEqual(restartCalls, ['code-x-backend'], 'a \'starting\' backend still holds pre-pull code and must be restarted');
    assert.deepEqual(result.restarted, { ids: ['code-x-backend'], ok: true, error: null });
  } finally {
    await env.restore();
  }
});

test('update(): a plugin backend that was never running is left stopped, not started', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('code-x');
    await dropLibraryEntry('code-x.json', { id: 'code-x', name: 'Code X', repo: 'https://example.com/org/code-x' });
    const restartCalls = [];
    const stubHost = {
      rescan: async () => {},
      list: async () => [{ id: 'code-x-backend', project: 'code-x', state: 'stopped' }],
      restart: async (id) => { restartCalls.push(id); },
    };
    const lib = createPluginLibrary({
      pluginHost: stubHost,
      _pullImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });

    const result = await lib.update('code-x');
    assert.equal(result.restarted, null, 'nothing running ⇒ nothing to restart');
    assert.deepEqual(restartCalls, [], 'update never starts a stopped backend');
  } finally {
    await env.restore();
  }
});
