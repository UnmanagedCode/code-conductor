// The mutation harness's Playwright canary (canaryFor, harness/mutation/playwright.ts)
// run through real Playwright: it must load and fail by name in every shape a
// web/e2e spec takes. Playwright validates a test's ancestor hooks against that
// test's OWN fixture pool and keys workers by the pool's worker fixtures, so the
// canary's test type decides both whether a root `beforeAll(({ cc }) => …)`
// loads and whether the canary shares the spec's worker.
//
// Each form gets a fresh mirror tree in the temp dir — web/playwright.config.ts,
// a stub web/e2e/harness/fixtures.ts with the real one's shape, one spec — and
// no browser: no test here takes `page`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canaryFor, parsePlaywrightReport } from '../harness/mutation/playwright.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO, 'node_modules', '@playwright', 'test', 'cli.js');
const RUN_MS = 25_000;

const CONFIG = `export default { testDir: './e2e', workers: 1, fullyParallel: false, projects: [{ name: 'desktop' }] };\n`;

// web/e2e/harness/fixtures.ts's shape: a worker option, a worker `cc`, and
// baseURL from `cc`. `cc` boots log to CC_CANARY_LOG.
const FIXTURES = `import fs from 'node:fs';
import { test as base } from '@playwright/test';

export const log = (event: string, workerIndex: number): void => { fs.appendFileSync(process.env.CC_CANARY_LOG!, \`\${event} \${workerIndex}\\n\`); };

export const test = base.extend<object, { ccOptions: { server?: string }; cc: { url: string } }>({
  ccOptions: [{}, { scope: 'worker', option: true }],
  cc: [async ({}, use, info) => { log('cc', info.workerIndex); await use({ url: 'http://127.0.0.1:9' }); }, { scope: 'worker' }],
  baseURL: async ({ cc }, use) => { await use(cc.url); },
});
`;

const FORMS = [
  {
    name: 'a fixture spec whose root beforeAll takes cc',
    file: 'web/e2e/root-hook.spec.ts',
    source: `import { test, log } from './harness/fixtures.ts';

test.use({ ccOptions: { server: 'root-hook' } });
test.beforeAll(async ({ cc }, info) => { log('beforeAll', info.workerIndex); if (!cc.url) throw new Error('no cc'); });
test('a spec test', async ({ cc }) => { if (!cc.url) throw new Error('no cc'); });
`,
    // Once: the canary shares the spec's worker, so the root beforeAll is not
    // re-run for it. The plain form below is the positive control for this log.
    log: (events) => assert.deepEqual(events.map((e) => e.event), ['cc', 'beforeAll']),
  },
  {
    name: 'a plain @playwright/test spec with a fixture-free root beforeAll',
    file: 'web/e2e/legacy/plain.spec.ts',
    source: `import { test } from '@playwright/test';
import { log } from '../harness/fixtures.ts';

test.beforeAll(async ({}, info) => { log('beforeAll', info.workerIndex); });
test('a spec test', async () => {});
`,
    // The canary's test type is not this spec's, so it runs in a worker of its
    // own and the root beforeAll runs there too — this is what the log reads
    // when a canary does not share the spec's worker. That worker boots `cc`:
    // Playwright's auto `_setupArtifacts` fixture reaches it through `baseURL`.
    log: (events) => {
      assert.deepEqual(events.map((e) => e.event), ['beforeAll', 'cc', 'beforeAll']);
      assert.notEqual(events[0].worker, events[2].worker);
      assert.equal(events[1].worker, events[2].worker);
    },
  },
  {
    name: 'a fixture spec with no root hook',
    file: 'web/e2e/no-hook.spec.ts',
    source: `import { test } from './harness/fixtures.ts';

test('a spec test', async ({ cc }) => { if (!cc.url) throw new Error('no cc'); });
`,
    log: (events) => assert.deepEqual(events.map((e) => e.event), ['cc']),
  },
];

function playwright(root, file, logFile) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'test', '--config', 'web/playwright.config.ts', '--reporter=json', file], {
      cwd: root, timeout: RUN_MS, killSignal: 'SIGKILL',
      env: { ...process.env, NO_COLOR: '1', CC_CANARY_LOG: logFile, PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(root, 'report.json') },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('the Playwright canary loads and fails by name in every spec form', async (t) => {
  for (const form of FORMS) {
    await t.test(form.name, { timeout: RUN_MS + 5_000 }, async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-canary-')));
      try {
        fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
        fs.mkdirSync(path.join(root, 'web', 'e2e', 'harness'), { recursive: true });
        fs.mkdirSync(path.join(root, path.dirname(form.file)), { recursive: true });
        fs.writeFileSync(path.join(root, 'web', 'playwright.config.ts'), CONFIG);
        fs.writeFileSync(path.join(root, 'web', 'e2e', 'harness', 'fixtures.ts'), FIXTURES);
        const canary = canaryFor(form.file, form.source, { project: 'desktop' });
        fs.writeFileSync(path.join(root, form.file), canary.content);
        const logFile = path.join(root, 'events.log');
        fs.writeFileSync(logFile, '');

        const run = await playwright(root, form.file, logFile);
        const reportFile = path.join(root, 'report.json');
        assert.ok(fs.existsSync(reportFile), `no report (exit ${run.code}): ${run.stderr.slice(-2000)}`);
        const parsed = parsePlaywrightReport(fs.readFileSync(reportFile, 'utf8'), { cwd: root, project: 'desktop', exitCode: run.code });

        assert.equal(parsed.compileError, false, String(parsed.counts.firstError ?? parsed.diagnostic ?? ''));
        assert.deepEqual(parsed.failedTests.map((f) => f.id), [canary.testId]);
        assert.equal(parsed.passed, 1);
        assert.equal(parsed.ran, 2);
        assert.deepEqual(parsed.files, [form.file]);
        assert.equal(canary.matches({ name: canary.testId.slice(form.file.length + 2) }), true);
        form.log(fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => {
          const [event, worker] = line.split(' ');
          return { event, worker: Number(worker) };
        }));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
