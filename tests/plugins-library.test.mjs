import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { registerLocalProject } from './helpers.mjs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPluginLibrary, resolveRepoUrl } from '../src/plugins/library.ts';
import { getPluginLibrarySettings } from '../src/appSettings.ts';
import { orchStoreRoot, adoptProject, listProjects, readProjectRecord } from '../src/projects.ts';
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
    assert.deepEqual((await lib.list()).skipped, [], 'the store dir\'s absence is silent');
    assert.equal(rows[0].sourceDir, undefined, 'the internal sourceDir is not leaked on the wire');
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
    assert.ok(skipped.every(s => s.dir === libraryDir()), 'each skip names the store dir it was read from');
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

test('list(): installed flips true once the derived name is REGISTERED', async () => {
  const env = await makePluginRoot();
  try {
    // A directory alone is not an install any more: the record is.
    const dir = path.join(env.root, '.plugins', 'code-share');
    await fs.mkdir(dir, { recursive: true });
    const lib = createPluginLibrary();
    assert.equal((await lib.list()).entries[0].installed, false,
      'an unregistered checkout is not an install');

    await registerLocalProject('code-share', dir);
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
    await registerLocalProject('code-share', path.join(env.root, 'code-share'));

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
    await registerLocalProject('code-share', path.join(env.root, 'code-share'));

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
    await dropLibraryEntry('worse.json', { id: 'worse', name: 'Worse', repo: 'git@github.com:org/worse.git' });
    await dropLibraryEntry('worst.json', { id: 'worst', name: 'Worst', repo: 'file:worst.git' });
    const cloneCalls = [];
    const lib = createPluginLibrary({ _cloneImpl: async (url) => { cloneCalls.push(url); return { code: 0, stdout: '', stderr: '' }; } });
    await rejectsWithStatus(lib.install('bad'), 400);
    await rejectsWithStatus(lib.install('worse'), 400);
    await rejectsWithStatus(lib.install('worst'), 400);
    assert.deepEqual(cloneCalls, [], 'every refusal lands before any clone');
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
    assert.equal(rows[0].path, await fs.realpath(outside));
    assert.deepEqual((await readProjectRecord('code-share')).location,
      { kind: 'local', path: await fs.realpath(outside) }, 'the adopted record is untouched');
    await assert.rejects(() => fs.stat(path.join(env.root, '.plugins', 'code-share')),
      'no checkout was created for a name already held');
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
    assert.ok((await fs.stat(path.join(env.root, '.plugins', 'code-share'))).isDirectory());
    assert.equal(rescanned, 1);
    assert.deepEqual(enabled, ['code-share'], 'the freshly discovered plugin is enabled by default');
    assert.equal(result.postClone, null, 'code-share has no postClone configured');

    const { entries: rows } = await lib.list();
    assert.equal(rows[0].installed, true);
  } finally {
    await env.restore();
  }
});

// PINS: the install target is cc's OWN plugin area, not the projects root — a
// directory in the root is a user's, and cloning into it is what made a plugin
// checkout indistinguishable from a project the user made.
test('install(): clones into .plugins/<name> and writes the record', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(path.join(destDir, 'conductor.plugin.json'),
          JSON.stringify({ id: 'code-share', name: 'Code Share', version: '1', pluginApi: 1 }));
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const result = await lib.install('code-share');
    const target = path.join(env.root, '.plugins', 'code-share');
    assert.equal(result.path, target);
    assert.ok((await fs.stat(target)).isDirectory());
    await assert.rejects(() => fs.stat(path.join(env.root, 'code-share')),
      'nothing is created in the projects root');

    const { readProjectRecord } = await import('../src/projects.ts');
    assert.deepEqual((await readProjectRecord('code-share')).location,
      { kind: 'local', path: target });
  } finally {
    await env.restore();
  }
});

// PINS: an installed plugin has NO kind flag — its row is shape-identical to
// any other project's, which is what makes deleting it an ordinary deregister
// rather than a route through an uninstall.
test('install(): an installed plugin\'s list_projects row is shape-identical to a non-plugin\'s', async () => {
  const env = await makePluginRoot();
  try {
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await lib.install('code-share');
    await registerLocalProject('ordinary', path.join(env.root, 'ordinary'));

    const { listProjects } = await import('../src/projects.ts');
    const rows = await listProjects();
    const mask = r => ({ ...r, name: '<name>', path: '<path>' });
    assert.deepEqual(rows.map(r => r.name), ['code-share', 'ordinary']);
    assert.deepEqual(mask(rows[0]), mask(rows[1]));
  } finally {
    await env.restore();
  }
});

// PINS: a REFUSED registration leaves no half-installed checkout behind for a
// later adopt or rescan to find — the clone is rolled back with the record.
test('install(): a registration refused after the clone cleans the checkout up', async () => {
  const env = await makePluginRoot();
  try {
    // Hold the transcript directory the install's checkout would take, so
    // registerProject refuses at the write.
    const target = path.join(env.root, '.plugins', 'code-share');
    const { registerProject } = await import('../src/projects.ts');
    await registerProject('holder', { kind: 'local', path: target });

    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => {
        await fs.mkdir(destDir, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await assert.rejects(() => lib.install('code-share'));
    await assert.rejects(() => fs.stat(target), 'the clone was rolled back');
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
    assert.equal(hookCalls[0].cwd, path.join(env.root, '.plugins', 'code-playwright'));
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
    assert.ok((await fs.stat(path.join(env.root, '.plugins', 'code-playwright'))).isDirectory(), 'clone was NOT removed');
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
    await registerLocalProject('code-x', path.join(env.root, 'code-x'));

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

// ── Local / offline catalogs ─────────────────────────────────────────────

// settings.json must be written BEFORE the first appSettings call under the
// root — the module caches the parsed document (docs/architecture.md →
// "Hand-editing `settings.json` in a test").
async function seedSettings(obj) {
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await fs.writeFile(path.join(orchStoreRoot(), 'settings.json'), JSON.stringify(obj));
}

async function dropEntryIn(dir, name, entry) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(entry));
}

function assertStatus(fn, statusCode) {
  assert.throws(fn, (e) => {
    assert.equal(e.statusCode, statusCode, `expected ${statusCode}, got ${e.statusCode}: ${e.message}`);
    return true;
  });
}

const fileUrl = (...segs) => pathToFileURL(path.join(...segs)).href;

test('resolveRepoUrl(): resolution table', async (t) => {
  const dir = '/srv/catalog';
  await t.test('T1 https passes through verbatim', () => {
    assert.equal(resolveRepoUrl('https://example.com/org/foo.git', dir), 'https://example.com/org/foo.git');
  });
  await t.test('T2 an explicit file URL is never joined to sourceDir', () => {
    assert.equal(resolveRepoUrl('file:///srv/m/foo.git', dir), 'file:///srv/m/foo.git');
  });
  await t.test('T3 bare and ./ relative forms are identical, relative to sourceDir', () => {
    assert.equal(resolveRepoUrl('foo.git', dir), fileUrl(dir, 'foo.git'));
    assert.equal(resolveRepoUrl('./foo.git', dir), fileUrl(dir, 'foo.git'));
  });
  await t.test('T4 multi-segment relative resolves under sourceDir', () => {
    assert.equal(resolveRepoUrl('mirror/foo.git', dir), fileUrl(dir, 'mirror', 'foo.git'));
  });
  await t.test('T5 .. is honoured', () => {
    assert.equal(resolveRepoUrl('../repos/foo.git', dir), pathToFileURL(path.resolve(dir, '..', 'repos', 'foo.git')).href);
  });
  await t.test('T6 an absolute path ignores sourceDir', () => {
    assert.equal(resolveRepoUrl('/abs/foo.git', dir), 'file:///abs/foo.git');
  });
  await t.test('T7 output is an encoded URL, never the raw path', () => {
    const out = resolveRepoUrl('my repos/foo.git', dir);
    assert.ok(out.startsWith('file:///'), out);
    assert.ok(out.includes('my%20repos'), out);
  });
  await t.test('T8 relative needs a source dir; absolute does not', () => {
    assert.equal(resolveRepoUrl('/abs/foo.git', null), 'file:///abs/foo.git');
    assertStatus(() => resolveRepoUrl('foo.git', null), 400);
  });
  for (const bad of ['ftp://h/x', 'git@github.com:org/x.git', 'C:\\x\\y.git', 'file:foo.git', 'file://host/x.git', 'a:b']) {
    await t.test(`T9 refuses ${bad}`, () => { assertStatus(() => resolveRepoUrl(bad, dir), 400); });
  }
  await t.test('T10 a colon after the first / is still a path', () => {
    const out = resolveRepoUrl('mirror/a:b.git', dir);
    assert.equal(out, fileUrl(dir, 'mirror', 'a:b.git'));
    assert.ok(out.startsWith('file:///'), out);
  });
});

test('getPluginLibrarySettings(): sanitiser', async (t) => {
  async function withSeed(seed, fn) {
    const env = await makePluginRoot();
    try {
      if (seed !== undefined) await seedSettings(seed);
      await fn();
    } finally { await env.restore(); }
  }
  await t.test('S1 no file -> defaults', () => withSeed(undefined, () => {
    assert.deepEqual(getPluginLibrarySettings(), { libraryDirs: [], builtinLibrary: true });
  }));
  await t.test('S2 builtinLibrary:false opts out', () => withSeed({ plugins: { builtinLibrary: false } }, () => {
    assert.equal(getPluginLibrarySettings().builtinLibrary, false);
  }));
  for (const v of ['false', 0, null]) {
    await t.test(`S3 builtinLibrary ${JSON.stringify(v)} keeps the built-ins`, () => withSeed({ plugins: { builtinLibrary: v } }, () => {
      assert.equal(getPluginLibrarySettings().builtinLibrary, true);
    }));
  }
  for (const [label, seed] of [['plugins string', { plugins: 'garbage' }], ['plugins array', { plugins: [] }], ['libraryDirs string', { plugins: { libraryDirs: 'x' } }]]) {
    await t.test(`S4 malformed ${label} -> defaults`, () => withSeed(seed, () => {
      assert.deepEqual(getPluginLibrarySettings(), { libraryDirs: [], builtinLibrary: true });
    }));
  }
  await t.test('S5 type/absolute filter, trim, normalise, dedupe keeping first', () => withSeed(
    { plugins: { libraryDirs: ['relative/d', 42, '', '  ', '/a/b/', '/a/b', '/a/./c'] } }, () => {
      assert.deepEqual(getPluginLibrarySettings().libraryDirs, ['/a/b', '/a/c']);
    }));
});

test('install(): a relative repo in a configured dir resolves against THAT dir, clones a file:// URL', async () => {
  const env = await makePluginRoot();
  const C = await mkdtemp('lib-cat-');
  try {
    await seedSettings({ plugins: { libraryDirs: [C] } });
    await dropEntryIn(C, 'code-kanban.json', { id: 'code-kanban', name: 'Kanban', repo: 'repos/code-kanban.git' });
    const calls = [];
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => { calls.push({ url, destDir }); await fs.mkdir(destDir, { recursive: true }); return { code: 0, stdout: '', stderr: '' }; },
    });
    const result = await lib.install('code-kanban');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, fileUrl(C, 'repos', 'code-kanban.git'));
    assert.equal(calls[0].destDir, path.join(env.root, '.plugins', 'code-kanban'));
    assert.equal(result.name, 'code-kanban');
  } finally {
    await env.restore();
    await rmrf(C);
  }
});

test('install(): a relative repo in the store library dir resolves against libraryDir()', async () => {
  const env = await makePluginRoot();
  try {
    await dropLibraryEntry('code-kanban.json', { id: 'code-kanban', name: 'Kanban', repo: 'repos/code-kanban.git' });
    const calls = [];
    const lib = createPluginLibrary({
      _cloneImpl: async (url, destDir) => { calls.push(url); await fs.mkdir(destDir, { recursive: true }); return { code: 0, stdout: '', stderr: '' }; },
    });
    await lib.install('code-kanban');
    assert.deepEqual(calls, [fileUrl(libraryDir(), 'repos', 'code-kanban.git')]);
  } finally {
    await env.restore();
  }
});

async function walkFiles(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function hardlinkedObjects(repoDir) {
  const files = await walkFiles(path.join(repoDir, '.git', 'objects'));
  const linked = [];
  for (const f of files) if ((await fs.stat(f)).nlink > 1) linked.push(f);
  return linked;
}

test('install/list/update: a real local mirror — no shared objects, fetch/upstream/pull all work offline', async () => {
  const env = await makePluginRoot();
  const C = await mkdtemp('lib-cat-');
  const seedDir = await mkdtemp('lib-seed-');
  const scratch = await mkdtemp('lib-scratch-');
  try {
    const mirror = path.join(C, 'repos', 'code-kanban.git');
    await fs.mkdir(mirror, { recursive: true });
    await git(mirror, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
    await git(seedDir, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(seedDir, 'config', 'user.email', 'test@test');
    await git(seedDir, 'config', 'user.name', 'test');
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v1');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v1');
    await git(seedDir, 'remote', 'add', 'origin', mirror);
    await git(seedDir, 'push', '-q', 'origin', 'main');

    // Precondition: this filesystem CAN hardlink a plain-path clone's objects,
    // otherwise the no-shared-objects assertion below could never fail.
    await git(scratch, 'clone', '-q', mirror, 'plain');
    assert.ok((await hardlinkedObjects(path.join(scratch, 'plain'))).length > 0,
      'precondition: a plain-path clone hardlinks objects here');

    await seedSettings({ plugins: { libraryDirs: [C] } });
    await dropEntryIn(C, 'code-kanban.json', { id: 'code-kanban', name: 'Kanban', repo: 'repos/code-kanban.git' });
    const lib = createPluginLibrary();
    const res = await lib.install('code-kanban');
    const target = path.join(env.root, '.plugins', 'code-kanban');
    assert.equal(res.path, target);
    assert.deepEqual(await hardlinkedObjects(target), [], 'the install shares no object files with the mirror');
    const { stdout: origin } = await run('git', ['-C', target, 'remote', 'get-url', 'origin']);
    assert.equal(origin.trim(), pathToFileURL(mirror).href);

    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v2');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v2');
    await git(seedDir, 'push', '-q', 'origin', 'main');

    const row = (await lib.list()).entries.find(r => r.id === 'code-kanban');
    assert.equal(row.installed, true);
    assert.equal(row.installedAs, 'code-kanban');
    assert.equal(row.behind, 1);
    assert.equal(row.updateAvailable, true);

    await lib.update('code-kanban');
    assert.equal(await fs.readFile(path.join(target, 'file.txt'), 'utf8'), 'v2');
  } finally {
    await env.restore();
    await rmrf(C);
    await rmrf(seedDir);
    await rmrf(scratch);
  }
});

test('list(): precedence — configured dirs override the store dir, in array order', async (t) => {
  // D1 sorts AFTER D2 by path, so array order and path order disagree.
  async function scenario(order, expected, { withD2 = true } = {}) {
    const env = await makePluginRoot();
    const D1 = await mkdtemp('lib-z-');
    const D2 = await mkdtemp('lib-a-');
    try {
      const dirs = { D1, D2 };
      await seedSettings({ plugins: { libraryDirs: order.map(k => dirs[k]) } });
      await dropLibraryEntry('x.json', { id: 'x', name: 'L', repo: 'https://example.com/o/x' });
      await dropEntryIn(D1, 'x.json', { id: 'x', name: 'D1', repo: 'https://example.com/o/x' });
      if (withD2) await dropEntryIn(D2, 'x.json', { id: 'x', name: 'D2', repo: 'https://example.com/o/x' });
      const rows = (await createPluginLibrary().list()).entries.filter(r => r.id === 'x');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, expected);
    } finally {
      await env.restore();
      await rmrf(D1);
      await rmrf(D2);
    }
  }
  await t.test('a [D1, D2] -> D2', () => scenario(['D1', 'D2'], 'D2'));
  await t.test('b [D2, D1] -> D1', () => scenario(['D2', 'D1'], 'D1'));
  await t.test('c store + [D1] -> D1', () => scenario(['D1'], 'D1', { withD2: false }));
});

test('list(): duplicate ids within one dir — sorted filename order, last wins', async () => {
  const env = await makePluginRoot();
  const C = await mkdtemp('lib-cat-');
  try {
    await seedSettings({ plugins: { libraryDirs: [C] } });
    for (let i = 0; i < 20; i++) {
      const f = `d${String(i).padStart(2, '0')}.json`;
      await dropEntryIn(C, f, { id: 'dup', name: f, repo: 'https://example.com/o/dup' });
    }
    const row = (await createPluginLibrary().list()).entries.find(r => r.id === 'dup');
    assert.equal(row.name, 'd19.json');
  } finally {
    await env.restore();
    await rmrf(C);
  }
});

test('list(): builtinLibrary:false suppresses the built-ins; drop-ins still serve', async (t) => {
  await t.test('a configured entry only', async () => {
    const env = await makePluginRoot();
    const C = await mkdtemp('lib-cat-');
    try {
      await seedSettings({ plugins: { libraryDirs: [C], builtinLibrary: false } });
      await dropEntryIn(C, 'mine.json', { id: 'only-mine', name: 'Mine', repo: 'repos/mine.git' });
      const ids = (await createPluginLibrary().list()).entries.map(r => r.id);
      assert.deepEqual(ids, ['only-mine']);
    } finally {
      await env.restore();
      await rmrf(C);
    }
  });
  await t.test('b a store-dir override of a built-in id remains', async () => {
    const env = await makePluginRoot();
    const C = await mkdtemp('lib-cat-');
    try {
      await seedSettings({ plugins: { libraryDirs: [C], builtinLibrary: false } });
      await dropEntryIn(C, 'mine.json', { id: 'only-mine', name: 'Mine', repo: 'repos/mine.git' });
      await dropLibraryEntry('code-share.json', { id: 'code-share', name: 'My CS', repo: 'https://example.com/fork/code-share' });
      const rows = (await createPluginLibrary().list()).entries;
      assert.deepEqual(rows.map(r => r.id).sort(), ['code-share', 'only-mine']);
      assert.equal(rows.find(r => r.id === 'code-share').name, 'My CS');
    } finally {
      await env.restore();
      await rmrf(C);
    }
  });
});

test('list(): a relative libraryDirs element is dropped, not resolved against the cwd', async () => {
  const env = await makePluginRoot();
  const C = await mkdtemp('lib-cat-');
  try {
    await dropEntryIn(C, 'rel.json', { id: 'rel-entry', name: 'Rel', repo: 'https://example.com/o/rel' });
    await seedSettings({ plugins: { libraryDirs: [path.relative(process.cwd(), C)] } });
    const { entries, skipped } = await createPluginLibrary().list();
    assert.ok(!entries.some(r => r.id === 'rel-entry'));
    assert.deepEqual(skipped, []);
  } finally {
    await env.restore();
    await rmrf(C);
  }
});

test('list(): each skip names the directory it was read from', async () => {
  const env = await makePluginRoot();
  const C = await mkdtemp('lib-cat-');
  try {
    await seedSettings({ plugins: { libraryDirs: [C] } });
    await fs.mkdir(libraryDir(), { recursive: true });
    await fs.writeFile(path.join(libraryDir(), 'broken.json'), '{ not json');
    await fs.writeFile(path.join(C, 'broken.json'), '{ not json');
    const { skipped } = await createPluginLibrary().list();
    assert.equal(skipped.length, 2);
    assert.ok(skipped.every(s => s.file === 'broken.json' && s.reason.length > 0));
    assert.deepEqual(skipped.map(s => s.dir).sort(), [libraryDir(), C].sort());
  } finally {
    await env.restore();
    await rmrf(C);
  }
});

test('list(): a missing configured dir is reported in skipped with file:null; built-ins still serve', async () => {
  const env = await makePluginRoot();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const gone = path.join(env.root, 'not-mounted');
    await seedSettings({ plugins: { libraryDirs: [gone] } });
    const { entries, skipped } = await createPluginLibrary().list();
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].dir, gone);
    assert.equal(skipped[0].file, null);
    assert.match(skipped[0].reason, /unreadable/);
    assert.equal(entries.length, 8);
  } finally {
    console.warn = origWarn;
    await env.restore();
  }
});

test('list()/install(): a mirror entry is the same install as the GitHub one (name from the resolved URL)', async () => {
  const env = await makePluginRoot();
  const C = await mkdtemp('lib-cat-');
  try {
    await seedSettings({ plugins: { libraryDirs: [C] } });
    await env.addProject('code-kanban');
    await dropEntryIn(C, 'kanban-mirror.json', { id: 'kanban-mirror', name: 'Mirror', repo: 'repos/code-kanban.git' });
    const cloneCalls = [];
    const lib = createPluginLibrary({ _cloneImpl: async (url) => { cloneCalls.push(url); return { code: 0, stdout: '', stderr: '' }; } });
    const row = (await lib.list()).entries.find(r => r.id === 'kanban-mirror');
    assert.equal(row.installed, true);
    assert.equal(row.installedAs, 'code-kanban');
    await rejectsWithStatus(lib.install('kanban-mirror'), 409);
    assert.deepEqual(cloneCalls, []);
  } finally {
    await env.restore();
    await rmrf(C);
  }
});

test('update(): a relative-repo entry pulls the project named by the resolved URL', async () => {
  const env = await makePluginRoot();
  const C = await mkdtemp('lib-cat-');
  try {
    await seedSettings({ plugins: { libraryDirs: [C] } });
    const registered = await env.addProject('code-kanban');
    await dropEntryIn(C, 'kanban-mirror.json', { id: 'kanban-mirror', name: 'Mirror', repo: 'repos/code-kanban.git' });
    const pulls = [];
    const lib = createPluginLibrary({ _pullImpl: async (cwd) => { pulls.push(cwd); return { code: 0, stdout: '', stderr: '' }; } });
    await lib.update('kanban-mirror');
    assert.deepEqual(pulls, [registered]);
  } finally {
    await env.restore();
    await rmrf(C);
  }
});

test('install(): a repo refusal is synchronous validation — onValidated never fires', async () => {
  const env = await makePluginRoot();
  try {
    await dropLibraryEntry('bad.json', { id: 'bad', name: 'Bad', repo: 'git@github.com:org/bad.git' });
    await dropLibraryEntry('ugly.json', { id: 'ugly', name: 'Ugly', repo: 'repos/my%20repo.git' });
    let validated = 0;
    const lib = createPluginLibrary({ _cloneImpl: async () => ({ code: 0, stdout: '', stderr: '' }) });
    await rejectsWithStatus(lib.install('bad', { onValidated: () => { validated++; } }), 400);
    await rejectsWithStatus(lib.install('ugly', { onValidated: () => { validated++; } }), 400);
    assert.equal(validated, 0);
  } finally {
    await env.restore();
  }
});

test('list(): an entry whose repo is refused lists as not installed, with a warning naming it', async () => {
  const env = await makePluginRoot();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    await dropLibraryEntry('bad.json', { id: 'bad-entry', name: 'Bad', repo: 'ftp://example.com/o/bad' });
    const row = (await createPluginLibrary().list()).entries.find(r => r.id === 'bad-entry');
    assert.equal(row.installed, false);
    assert.equal(row.installedAs, null);
    assert.ok(warns.some(w => w.includes('bad-entry')), `a warning names the entry: ${JSON.stringify(warns)}`);
  } finally {
    console.warn = origWarn;
    await env.restore();
  }
});
