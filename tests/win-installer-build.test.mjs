import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildInstaller } from '../installer/windows/build.mjs';
import { makeZip } from './winInstallerZip.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-build-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'installer', 'windows'), { recursive: true });
  git(repo, '-c', 'init.defaultBranch=work', 'init', '-q');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"code-conductor","version":"3.2.1"}\n');
  fs.writeFileSync(path.join(repo, 'LICENSE'), 'license text\n');
  for (const f of ['launcher.nsi', 'installer.nsi', 'setup.mjs']) fs.writeFileSync(path.join(repo, 'installer', 'windows', f), `committed ${f}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'c1');

  // fake makensis: records argv; for installer.nsi snapshots the stage; writes OUTFILE.
  const record = path.join(root, 'calls.jsonl');
  const fake = path.join(root, 'makensis');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
if (argv[0] === '--version') process.exit(0);
const def = (n) => (argv.find((a) => a.startsWith('-D' + n + '=')) || '').slice(n.length + 3);
const stage = def('STAGE');
const entry = { argv, stageNode: null };
if (stage) {
  const walk = (d, p = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), p + e.name + '/') : [p + e.name]);
  entry.files = walk(stage);
  entry.launcherExe = fs.existsSync(path.join(stage, 'code-conductor.exe'));
  entry.setup = fs.readFileSync(path.join(stage, 'installer/windows/setup.mjs'), 'utf8');
  fs.cpSync(path.join(stage, 'cc.bundle'), ${JSON.stringify(path.join(root, 'seen.bundle'))});
}
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(entry) + '\\n');
fs.writeFileSync(def('OUTFILE'), 'MZ fake');
`);
  fs.chmodSync(fake, 0o755);

  const zip = makeZip({ 'node-vX-win-x64/node.exe': 'NODEEXE', 'node-vX-win-x64/node_modules/npm/bin/npm-cli.js': '//npm' });
  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir);
  const pins = { node: { version: 'X', url: 'https://example.invalid/node-vX-win-x64.zip', sha256: sha } };
  return {
    root, repo, fake, zip, pins, cacheDir, outDir: path.join(root, 'out'),
    calls: () => fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.argv[0] !== '--version'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const opts = (t, extra = {}) => ({
  repoDir: t.repo, outDir: t.outDir, cacheDir: t.cacheDir, pins: t.pins, makensis: t.fake,
  branch: 'main', remoteUrl: 'https://example.invalid/cc.git', log: () => {},
  download: async () => assert.fail('cache should satisfy the pin'), ...extra,
});

test('happy path: stage has bundle@HEAD, node/, HEAD-archived sources; defines passed; launcher before installer', async () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.repo, 'installer', 'windows', 'setup.mjs'), 'UNCOMMITTED EDIT\n');
    fs.writeFileSync(path.join(t.cacheDir, 'node-vX-win-x64.zip'), t.zip);
    const warnings = [];
    const r = await buildInstaller(opts(t, { log: (m) => warnings.push(m) }));
    const head = git(t.repo, 'rev-parse', '--short=8', 'HEAD');
    assert.equal(r.outFile, path.join(t.outDir, `code-conductor-setup-3.2.1-${head}.exe`));
    assert.ok(fs.existsSync(r.outFile));
    assert.ok(warnings.some((m) => /dirty/.test(m)));

    const [launcher, installer] = t.calls();
    assert.match(launcher.argv.at(-1), /launcher\.nsi$/);
    assert.match(installer.argv.at(-1), /installer\.nsi$/);
    const defs = Object.fromEntries(installer.argv.filter((a) => a.startsWith('-D')).map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
    assert.equal(defs.VERSION, '3.2.1');
    assert.equal(defs.COMMIT, head);
    assert.equal(defs.BRANCH, 'main');
    assert.equal(defs.REMOTE_URL, 'https://example.invalid/cc.git');
    assert.equal(defs.OUTFILE, r.outFile);

    assert.ok(installer.files.includes('LICENSE'));
    assert.ok(installer.files.includes('node/node.exe'));
    assert.ok(installer.files.includes('node/node_modules/npm/bin/npm-cli.js'));
    assert.ok(installer.files.includes('installer/windows/installer.nsi'));
    assert.equal(installer.setup, 'committed setup.mjs\n', 'sources come from HEAD, not the working tree');
    assert.equal(installer.launcherExe, true);

    const clone = path.join(t.root, 'clone');
    execFileSync('git', ['clone', '-q', '--branch', 'main', path.join(t.root, 'seen.bundle'), clone]);
    assert.equal(git(clone, 'rev-parse', 'HEAD'), git(t.repo, 'rev-parse', 'HEAD'));
  } finally { t.cleanup(); }
});

test('a cached zip with the wrong sha is re-downloaded; a download that still mismatches is refused', async () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.cacheDir, 'node-vX-win-x64.zip'), 'corrupt');
    await assert.rejects(buildInstaller(opts(t, {
      download: async (url, dest) => fs.writeFileSync(dest, 'tampered'),
    })), /sha256 mismatch/);
    assert.equal(fs.existsSync(path.join(t.cacheDir, 'node-vX-win-x64.zip')), false);
    assert.equal(fs.existsSync(path.join(t.root, 'calls.jsonl')), false, 'makensis never ran');

    const r = await buildInstaller(opts(t, { download: async (url, dest) => fs.writeFileSync(dest, t.zip) }));
    assert.ok(fs.existsSync(r.outFile));
  } finally { t.cleanup(); }
});
