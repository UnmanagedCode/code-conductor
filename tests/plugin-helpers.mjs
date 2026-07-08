// Shared scaffolding for the plugin-system tests (not a .test file — run.mjs
// skips it). Builds a temp PROJECTS_ROOT populated with plugin projects
// cloned from tests/fixtures/fake-plugin/.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_PLUGIN_DIR = path.join(__dirname, 'fixtures', 'fake-plugin');

export async function readFixtureManifest() {
  return JSON.parse(await fs.readFile(path.join(FAKE_PLUGIN_DIR, 'conductor.plugin.json'), 'utf8'));
}

// Temp projects root with PROJECTS_ROOT pointed at it. Callers MUST await
// restore() in finally. Each test file runs in its own process, so the env
// mutation cannot leak across files.
export async function makePluginRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-root-'));
  const prevRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;

  async function addPluginProject(name, { manifest, withFixtureFiles = true } = {}) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    if (withFixtureFiles) await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true });
    if (manifest !== undefined) {
      await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify(manifest, null, 2));
    }
    return dir;
  }

  async function addProject(name) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async function restore() {
    if (prevRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = prevRoot;
    await fs.rm(root, { recursive: true, force: true });
  }

  return { root, addPluginProject, addProject, restore };
}

export function waitFor(predicate, { timeout = 15000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let val;
      try { val = await predicate(); } catch { val = false; }
      if (val) return resolve(val);
      if (Date.now() >= deadline) return reject(new Error('waitFor timed out'));
      setTimeout(tick, interval);
    };
    tick();
  });
}
