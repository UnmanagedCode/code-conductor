// Real build: the pinned node zip is downloaded and checked against its pin,
// and the real makensis produces an installer exe.
//   RUN_WIN_INSTALLER_BUILD=1 node tests/run.mjs tests/win-installer-build.real.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstaller } from '../installer/windows/build.mjs';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = process.env.RUN_WIN_INSTALLER_BUILD ? test : test.skip.bind(test);

t('real makensis + real pinned node download produce a PE installer', { timeout: 600_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-real-build-'));
  try {
    const pins = JSON.parse(fs.readFileSync(path.join(repoDir, 'installer', 'windows', 'pins.json'), 'utf8'));
    const r = await buildInstaller({
      repoDir, outDir: out, cacheDir: path.join(repoDir, 'build', 'cache'), pins,
      branch: 'main', remoteUrl: 'https://example.invalid/cc.git', log: () => {},
    });
    const head = fs.readFileSync(r.outFile).subarray(0, 2).toString('latin1');
    assert.equal(head, 'MZ');
    assert.ok(fs.statSync(r.outFile).size > 20_000_000);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
