// Builds the per-user Windows installer on Linux:
//   npm run build:win-installer
// Env: CC_WIN_BRANCH (default main), CC_WIN_REMOTE_URL (default the GitHub
// repo), MAKENSIS (default makensis). Reproducible in its inputs (pinned
// node + HEAD), not byte-identical.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(cmd, args, { cwd, input, allowFail } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  return r;
}

async function defaultDownload(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url} failed: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// The pinned zip, from cache when its sha matches, else downloaded; refuses
// anything whose sha256 is not the pin.
async function fetchPinned(pin, cacheDir, download, log) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, path.basename(new URL(pin.url).pathname));
  if (fs.existsSync(file) && sha256(file) === pin.sha256) {
    log(`node: using cached ${file}`);
    return file;
  }
  log(`node: downloading ${pin.url}`);
  await download(pin.url, file);
  const got = sha256(file);
  if (got !== pin.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`sha256 mismatch for ${pin.url}: got ${got}, pinned ${pin.sha256}`);
  }
  return file;
}

export async function buildInstaller({
  repoDir, outDir, cacheDir, pins, makensis = 'makensis', branch, remoteUrl,
  log = console.log, download = defaultDownload, stageDir,
}) {
  for (const tool of [makensis, 'git', 'unzip', 'tar']) {
    const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') {
      throw new Error(`${tool} not found${tool === makensis ? ' (sudo apt install nsis)' : ''}`);
    }
  }
  const git = (args, opts) => run('git', ['-C', repoDir, ...args], opts);
  const commit = git(['rev-parse', '--short=8', 'HEAD']).stdout.trim();
  const version = JSON.parse(git(['show', 'HEAD:package.json']).stdout).version;
  if (git(['status', '--porcelain']).stdout.trim()) {
    log('warning: working tree is dirty; only HEAD is bundled');
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (git(['rev-parse', '--verify', '-q', remoteRef], { allowFail: true }).status === 0
    && git(['merge-base', '--is-ancestor', 'HEAD', remoteRef], { allowFail: true }).status !== 0) {
    log(`warning: HEAD is not contained in origin/${branch}; the installed checkout will report ahead or diverged in self-update until the commit is on ${branch}`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-win-build-'));
  const stage = stageDir ?? path.join(work, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  try {
    const tarFile = path.join(work, 'src.tar');
    git(['archive', '--format=tar', '-o', tarFile, 'HEAD', 'installer/windows', 'LICENSE']);
    run('tar', ['-xf', tarFile, '-C', stage]);

    const zip = await fetchPinned(pins.node, cacheDir, download, log);
    const extract = path.join(work, 'node-extract');
    run('unzip', ['-q', zip, '-d', extract]);
    const top = fs.readdirSync(extract);
    const root = top.length === 1 && fs.statSync(path.join(extract, top[0])).isDirectory()
      ? path.join(extract, top[0]) : extract;
    fs.renameSync(root, path.join(stage, 'node'));

    const bare = path.join(work, 'bundle-repo');
    run('git', ['init', '-q', '--bare', bare]);
    run('git', ['-C', bare, 'fetch', '-q', repoDir, `HEAD:refs/heads/${branch}`]);
    const bundle = path.join(stage, 'cc.bundle');
    run('git', ['-C', bare, 'bundle', 'create', bundle, `refs/heads/${branch}`]);
    run('git', ['-C', bare, 'bundle', 'verify', bundle]);

    const nsi = (name) => path.join(stage, 'installer', 'windows', name);
    run(makensis, ['-V2', `-DOUTFILE=${path.join(stage, 'code-conductor.exe')}`, nsi('launcher.nsi')]);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `code-conductor-setup-${version}-${commit}.exe`);
    run(makensis, [
      '-V2', `-DVERSION=${version}`, `-DCOMMIT=${commit}`, `-DBRANCH=${branch}`,
      `-DREMOTE_URL=${remoteUrl}`, `-DSTAGE=${stage}`, `-DOUTFILE=${outFile}`, nsi('installer.nsi'),
    ]);
    if (!fs.existsSync(outFile)) throw new Error(`makensis did not produce ${outFile}`);
    log(`built ${outFile}`);
    return { outFile, version, commit };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const pins = JSON.parse(fs.readFileSync(path.join(repoDir, 'installer', 'windows', 'pins.json'), 'utf8'));
  buildInstaller({
    repoDir,
    outDir: path.join(repoDir, 'build', 'win-installer'),
    cacheDir: path.join(repoDir, 'build', 'cache'),
    pins,
    makensis: process.env.MAKENSIS || 'makensis',
    branch: process.env.CC_WIN_BRANCH || 'main',
    remoteUrl: process.env.CC_WIN_REMOTE_URL || 'https://github.com/UnmanagedCode/code-conductor.git',
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
