// Windows end-to-end smoke: cc running natively on win32 against a real
// signed-in `claude` and Git for Windows. Skipped unless RUN_WIN_SMOKE is set.
//
//   $env:RUN_WIN_SMOKE='1'; node --test --test-reporter=spec tests\win-smoke.real.test.mjs
//
// Run it directly, not through tests/run.mjs, as a non-elevated user under an
// interactive-type logon: a network logon (plain SSH) is refused the process
// probes and `taskkill /T` this suite asserts with. The server under test is a
// disposable clone of HEAD, so uncommitted changes are not under test. The
// steps are ordered and share one server lineage; a failed step's dependants
// fail naming it. Harness: tests/winSmoke.mjs.

import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { api } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { SYSTEMS_UNAVAILABLE, VOICE_UNAVAILABLE } from '../src/capabilities.ts';
import { encodeCwd } from '../src/projects.ts';
import {
  until, processTable, treeOf, isChildOf, aliveOf, describeProcs, visibleWindows, taskkillTree,
  serverEnv, git, npm, healthPid, startServer, logTail, newestJsonl,
  wsSend, wsPrompt, mcpCall, mcpList,
} from './winSmoke.mjs';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = process.env.RUN_WIN_SMOKE ? describe : describe.skip.bind(describe);

const TURN = 120_000;

d('Windows smoke (real claude, Git for Windows)', () => {
  let work, appDir, nodeLink, originDir, projects, logFile, base, wsUrl, port, runStart;
  let baseline = [];
  const servers = [];   // {pid, created} of every server in the lineage, incl. restart replacements
  const planFiles = [];
  const plansDir = path.join(os.homedir(), '.claude', 'plans');
  const state = {};

  const demoDir = () => path.join(projects, 'demo');
  const rows = async () => (await api(base, 'GET', '/api/instances')).body;
  const row = async (id) => (await rows()).find(r => r.id === id);
  const events = async (id) => (await api(base, 'GET', `/api/instances/${id}/events?limit=400`)).body.events;
  const maxSeq = async (id) => Math.max(-1, ...(await events(id)).map(e => Number(e._seq) || -1));
  const textAfter = async (id, seq) => (await events(id))
    .filter(e => e.kind === 'text_delta' && Number(e._seq) > seq).map(e => e.text).join('');
  const fail = (msg) => `${msg}\n--- server.log tail ---\n${logTail(logFile)}`;
  const call = async (method, urlPath, body) => {
    try { return await api(base, method, urlPath, body); }
    catch (e) { assert.fail(fail(`${method} ${urlPath}: ${e.message} (${e.cause?.code ?? 'no cause'})`)); }
  };

  // Keyed on pid + creation time, so a reused pid is never taken for a server.
  async function track(pid) {
    const p = (await processTable()).find(q => q.pid === pid);
    assert.ok(p, fail(`server pid ${pid} is not in the process table`));
    servers.push(p);
  }

  async function launch(root = projects) {
    const r = await startServer({ appDir, env: serverEnv({ installDir: work, projectsRoot: root, port }), logFile, base });
    await track(r.health.pid);
    return r.health;
  }

  async function newServerPid(oldPid) {
    const p = await until('a replacement server', async () => {
      const q = await healthPid(base);
      return q && q !== oldPid ? q : null;
    }, TURN);
    await track(p);
    return p;
  }

  async function stopServer() {
    const p = await healthPid(base);
    assert.ok(p, fail('no server is up'));
    await taskkillTree(p);
    await until('the server to go down', async () => (await healthPid(base)) == null, 30_000);
  }

  async function spawnWorker(extra = {}) {
    const r = await api(base, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions', temp: false, ...extra });
    assert.ok(r.body?.id, fail(`spawn refused: ${r.status} ${JSON.stringify(r.body)}`));
    await until(`instance ${r.body.id} idle`, async () => (await row(r.body.id))?.status === 'idle', 90_000);
    // The spawn response predates the session id.
    return until('its sessionId', async () => { const w = await row(r.body.id); return w?.sessionId ? w : null; }, 30_000);
  }

  async function kill(id) {
    const r = await api(base, 'DELETE', `/api/instances/${id}`);
    assert.ok(r.status < 300, fail(`DELETE ${id} → ${r.status} ${JSON.stringify(r.body)}`));
  }

  // Waits for a turn's reply text matching `re`, counting only events after `seq`.
  async function reply(id, seq, re, what) {
    return until(`${what} (got: ${JSON.stringify(await textAfter(id, seq))})`,
      async () => re.test(await textAfter(id, seq)), TURN);
  }

  async function waitForKind(id, kind, seq, timeout = TURN) {
    return until(`a ${kind} event`, async () => (await events(id)).find(e => e.kind === kind && Number(e._seq) > seq), timeout);
  }

  // `pid`'s tree once it holds the running tool's shell, so a kill check has a busy tree to judge.
  async function busyTree(pid) {
    return until(`the tool shell in pid ${pid}'s tree`, async () => {
      const tree = treeOf(await processTable(), pid);
      return tree.some(q => /^(bash|sh|sleep)\.exe$/i.test(q.name)) ? tree : null;
    }, 15_000, 500);
  }

  // A process tree must be gone within `timeout`; the failure names the survivors.
  async function assertGone(snapshot, what, timeout = 5_000) {
    try { await until(what, async () => (await aliveOf(snapshot)).length === 0, timeout, 500); }
    catch { assert.fail(fail(`${what}: survivors ${describeProcs(await aliveOf(snapshot))}`)); }
  }

  // A process whose ancestry reaches a server this suite started, even through a dead parent.
  function ours(p, table) {
    for (let cur = p, hops = 0; cur && hops < 64; hops++) {
      if (servers.some(s => isChildOf(cur, s))) return true;
      const child = cur;
      cur = table.find(q => isChildOf(child, q));
    }
    return false;
  }

  before(async () => {
    if (os.platform() !== 'win32') throw new Error('RUN_WIN_SMOKE needs a Windows host');
    try { baseline = await processTable(); }
    catch (e) {
      const why = `${e.stderr ?? ''}${e.message}`;
      if (/access\s+(?:is\s+)?denied|E_ACCESSDENIED/i.test(why)) {
        throw new Error('process probes need an interactive-type logon; a network logon such as plain SSH is refused ' +
          'WMI and `taskkill /T` for a standard user — see docs/architecture.md (RUN_WIN_SMOKE)');
      }
      throw new Error(`process probe failed: ${why}`);
    }
    runStart = Date.now();
    work = await mkdtemp('cc-winsmoke-');
    originDir = path.join(work, 'origin.git');
    // The install layout the launcher's env assumes: node at `node`, the checkout at `app`.
    appDir = path.join(work, 'app');
    nodeLink = path.join(work, 'node');
    fs.symlinkSync(path.dirname(process.execPath), nodeLink, 'junction');
    projects = path.join(work, 'projects');
    logFile = path.join(work, 'server.log');
    fs.mkdirSync(projects);
    // A named branch on a local bare origin: self-update pulls from it, and the
    // checkout under test is never the one the suite was started from.
    await git(work, 'init', '-q', '--bare', originDir);
    await git(repoDir, 'push', '-q', originDir, 'HEAD:refs/heads/smoke');
    await git(originDir, 'symbolic-ref', 'HEAD', 'refs/heads/smoke');
    await git(work, 'clone', '-q', originDir, appDir);
    await npm(appDir, 'ci', '--prefer-offline', '--no-audit', '--no-fund');
    port = await new Promise((resolve, reject) => {
      const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
        const p = s.address().port; s.close(() => resolve(p));
      });
    });
    base = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
  }, { timeout: 600_000 });

  after(async () => {
    if (!work) return;
    try {
      const p = await healthPid(base);
      if (p) await taskkillTree(p);
      for (const s of await aliveOf(servers)) await taskkillTree(s.pid);
      const table = await processTable();
      for (const q of table) {
        if (q.name.toLowerCase() === 'claude.exe' && !baseline.some(b => b.pid === q.pid) && ours(q, table)) await taskkillTree(q.pid);
      }
      // Every transcript dir under this run's work dir, under either spelling of its root.
      const prefix = encodeCwd(work).toLowerCase();
      const root = path.join(os.homedir(), '.claude', 'projects');
      for (const n of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        if (n.toLowerCase().startsWith(prefix)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
      }
      for (const f of planFiles) {
        if (path.dirname(path.resolve(f)).toLowerCase() === plansDir.toLowerCase()) fs.rmSync(f, { force: true });
      }
    } finally {
      // Unlinked whatever failed above, so no recursive delete of the work dir can reach the node install.
      if (nodeLink) {
        try { fs.unlinkSync(nodeLink); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
  }, { timeout: 60_000 });

  test('boot: health identifies cc, log has claude OK, no Git Bash warning', { timeout: 120_000 }, async (t) => {
    const dirty = await git(repoDir, 'status', '--porcelain', '--untracked-files=no');
    if (dirty) t.diagnostic('uncommitted changes are not under test — the server runs a clone of HEAD');
    const h = await launch();
    state.health = h;
    assert.equal(h.app, 'code-conductor');
    assert.ok((await processTable()).some(p => p.pid === h.pid), `health.pid ${h.pid} is not a live process`);
    await until('"claude OK" in server.log', () => /claude OK/.test(fs.readFileSync(logFile, 'utf8')), 30_000);
    assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /bash\.exe not found/);
  });

  test('dropped features refuse with stable codes', { timeout: 60_000 }, async () => {
    assert.ok(state.health, 'needs the boot step');
    assert.deepEqual(state.health.capabilities, { remoteSystems: false, fuseUnion: false, voice: false });
    const systems = await api(base, 'GET', '/api/settings/systems');
    assert.equal(systems.status, 501);
    assert.equal(systems.body.code, SYSTEMS_UNAVAILABLE);
    for (const p of ['/api/tts/status', '/api/transcribe/status']) {
      const r = await api(base, 'GET', p);
      assert.equal(r.status, 501, p);
      assert.equal(r.body.code, VOICE_UNAVAILABLE, p);
    }
    const adopt = await api(base, 'POST', '/api/projects/external', { name: 'remote-adopt', path: projects, system: 'x' });
    assert.equal(adopt.status, 200);
    assert.equal(adopt.body.ok, false);
    assert.equal(adopt.body.code, SYSTEMS_UNAVAILABLE);
    const tools = await mcpList(base);
    assert.ok(tools.includes('project_bash'), `tools/list: ${tools.join(',')}`);
    for (const gone of ['system_bash', 'set_project_remote']) assert.ok(!tools.includes(gone), `${gone} is listed`);
  });

  test('create project makes the initial commit', { timeout: 60_000 }, async () => {
    assert.ok(state.health, 'needs the boot step');
    const r = await api(base, 'POST', '/api/projects', { name: 'demo' });
    assert.ok(r.status < 300, fail(`create → ${r.status} ${JSON.stringify(r.body)}`));
    assert.equal(await git(demoDir(), 'rev-list', '--count', 'HEAD'), '1');
    assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /refusing the initial commit/);
    state.project = true;
  });

  test('worker answers a prompt over WS', { timeout: TURN + 120_000 }, async () => {
    assert.ok(state.project, 'needs the create-project step');
    const w = await spawnWorker();
    await wsPrompt(wsUrl, w.id, 'Reply with the two letters P and O, then the two letters N and G, joined into one word, and nothing else.');
    await reply(w.id, -1, /PONG/, 'PONG');
    state.w3 = w;
  });

  test('claude Bash tool runs under Git Bash', { timeout: TURN + 30_000 }, async () => {
    assert.ok(state.w3, 'needs the worker-answers step');
    const seq = await maxSeq(state.w3.id);
    await wsPrompt(wsUrl, state.w3.id, 'Use the Bash tool to run exactly: echo BV=$BASH_VERSION; pwd');
    const results = async () => JSON.stringify((await events(state.w3.id)).filter(e => e.kind === 'tool_result' && Number(e._seq) > seq));
    await until('a Bash tool_result with BV=', async () => /BV=\d/.test(await results()), TURN);
    // `pwd` prints Git Bash's POSIX spelling of the project dir, not a `C:\` one.
    assert.match(await results(), /\\n\/[^"\\]*\/projects\/demo"/);
  });

  test('attachment reaches the CLI and is served back', { timeout: TURN + 30_000 }, async () => {
    assert.ok(state.w3, 'needs the worker-answers step');
    const id = state.w3.id;
    const marker = `smoke${randomBytes(4).toString('hex')}`;
    const seq = await maxSeq(id);
    await wsPrompt(wsUrl, id, 'Reply with the single word written in the attached file, and nothing else.',
      [{ name: 'note.txt', mediaType: 'text/plain', dataBase64: Buffer.from(`${marker}\n`).toString('base64') }]);
    await reply(id, seq, new RegExp(marker), 'the marker word');
    const echo = (await events(id)).find(e => e.kind === 'user_echo' && Number(e._seq) > seq);
    const filename = echo?.attachments?.[0]?.filename;
    assert.ok(filename, `user_echo carries no attachment: ${JSON.stringify(echo)}`);
    const served = await fetch(`${base}/api/instances/${id}/attachments/${encodeURIComponent(filename)}`);
    assert.equal(served.status, 200);
    assert.match(await served.text(), new RegExp(marker));
    await kill(id);
  });

  test('plan mode surfaces a plan_request', { timeout: TURN + 120_000 }, async () => {
    assert.ok(state.project, 'needs the create-project step');
    const w = await spawnWorker({ mode: 'plan' });
    await wsPrompt(wsUrl, w.id, 'Plan adding a file hello.txt containing the word hi. Do not implement it; present the plan for approval.');
    const pr = await waitForKind(w.id, 'plan_request', -1);
    assert.ok(typeof pr.plan === 'string' && pr.plan.trim(), `plan_request has no plan: ${JSON.stringify(pr)}`);
    assert.match(String(pr.planPath), /[\\/]\.claude[\\/]plans[\\/].+\.md$/);
    planFiles.push(pr.planPath);
    await kill(w.id);
  });

  test('interrupt ends a busy turn, worker stays usable', { timeout: 2 * TURN + 120_000 }, async () => {
    assert.ok(state.project, 'needs the create-project step');
    const w = await spawnWorker();
    await wsPrompt(wsUrl, w.id, 'Use the Bash tool to run `sleep 60`, then reply done.');
    await waitForKind(w.id, 'tool_use', -1);
    const seq = await maxSeq(w.id);
    await wsSend(wsUrl, { t: 'interrupt', id: w.id, force: true });
    await waitForKind(w.id, 'turn_end', seq, 15_000);
    await until('idle after the interrupt', async () => (await row(w.id))?.status === 'idle', 15_000);
    const seq2 = await maxSeq(w.id);
    await wsPrompt(wsUrl, w.id, 'Reply with the single word ok.');
    await reply(w.id, seq2, /\bok\b/i, 'ok after the interrupt');
    await kill(w.id);
  });

  test('worktree create runs the hook; commit, sync, merge land on parent', { timeout: 180_000 }, async () => {
    assert.ok(state.project, 'needs the create-project step');
    const storeDir = path.join(projects, '.code-conductor', 'projects', 'demo');
    fs.mkdirSync(storeDir, { recursive: true });
    const markerName = `cc-smoke-hook-${randomBytes(4).toString('hex')}.txt`;
    const marker = path.join(os.tmpdir(), markerName);
    fs.writeFileSync(path.join(storeDir, 'post-worktree-create.sh'), `echo ran > "$TEMP/${markerName}"\n`);
    try {
      const r = await api(base, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions', worktree: true, temp: false });
      assert.ok(r.body?.id, fail(`worktree spawn refused: ${JSON.stringify(r.body)}`));
      await until('worktree instance idle', async () => (await row(r.body.id))?.status === 'idle', 90_000);
      const wt = (await api(base, 'GET', '/api/projects/demo/worktrees')).body[0];
      assert.ok(wt?.worktreePath, `worktree list: ${JSON.stringify(wt)}`);
      await until('the post-worktree-create hook marker', () => fs.existsSync(marker), 10_000);
      fs.writeFileSync(path.join(wt.worktreePath, 'smoke.txt'), 'from worktree\n');
      await git(wt.worktreePath, 'add', 'smoke.txt');
      await git(wt.worktreePath, 'commit', '-q', '-m', 'smoke change');
      await kill(r.body.id);
      const s = await api(base, 'POST', `/api/projects/demo/worktrees/${wt.worktreeName}/sync`, {});
      assert.ok(s.body?.ok, `sync: ${JSON.stringify(s.body)}`);
      const m = await api(base, 'POST', `/api/projects/demo/worktrees/${wt.worktreeName}/merge`, {});
      assert.ok(m.body?.ok, `merge: ${JSON.stringify(m.body)}`);
      assert.ok(await git(demoDir(), 'log', '--merges', '--oneline', '-1'), 'no merge commit on parent');
      assert.ok(fs.existsSync(path.join(demoDir(), 'smoke.txt')), 'smoke.txt not on parent');
    } finally { fs.rmSync(marker, { force: true }); }
  });

  test('project_bash runs under Git Bash via /mcp', { timeout: 60_000 }, async () => {
    assert.ok(state.project, 'needs the create-project step');
    const r = await mcpCall(base, 'project_bash', { project: 'demo', command: 'echo hi && git status -s', description: 'Echo and show status' });
    assert.ok(!r.result?.isError, `isError: ${JSON.stringify(r)}`);
    assert.match(JSON.stringify(r.result), /hi/);
  });

  test('busy kill: fast, interrupt-first, no orphaned tree, jsonl intact', { timeout: TURN + 120_000 }, async () => {
    assert.ok(state.project, 'needs the create-project step');
    const t0 = Date.now();
    const w = await spawnWorker();
    await wsPrompt(wsUrl, w.id, 'Use the Bash tool to run `sleep 60`.');
    await waitForKind(w.id, 'tool_use', -1);
    const snapshot = await busyTree(w.pid);
    const start = performance.now();
    await kill(w.id);
    const took = performance.now() - start;
    assert.ok(took <= 7_000, `DELETE took ${Math.round(took)} ms`);
    await assertGone(snapshot, 'the busy worker tree to exit');
    const lines = fs.readFileSync(newestJsonl(demoDir(), t0), 'utf8').split(/\r?\n/).filter(Boolean);
    assert.doesNotThrow(() => JSON.parse(lines.at(-1)), 'the jsonl ends mid-line');
  });

  test('idle kill: graceful stop writes last-prompt, no orphaned tree', { timeout: TURN + 120_000 }, async () => {
    assert.ok(state.project, 'needs the create-project step');
    const t0 = Date.now();
    const w = await spawnWorker();
    await wsPrompt(wsUrl, w.id, 'Reply with the single word ok.');
    await reply(w.id, -1, /ok/i, 'ok');
    await until('idle after the turn', async () => (await row(w.id))?.status === 'idle', 30_000);
    const snapshot = treeOf(await processTable(), (await row(w.id)).pid);
    assert.ok(snapshot.length, `worker pid ${w.pid} is not running`);
    await kill(w.id);
    await assertGone(snapshot, 'the idle worker tree to exit');
    const tail = fs.readFileSync(newestJsonl(demoDir(), t0), 'utf8').split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
    assert.match(tail, /last-prompt/, `no last-prompt in the jsonl tail:\n${tail}`);
  });

  test('resume restart resurrects the session and pages history', { timeout: 2 * TURN + 60_000 }, async () => {
    assert.ok(state.project, 'needs the create-project step');
    const w = await spawnWorker();
    await wsPrompt(wsUrl, w.id, 'Reply with the single word ready.');
    await reply(w.id, -1, /ready/i, 'ready');
    const oldPid = await healthPid(base);
    await api(base, 'POST', '/api/admin/restart', { resume: true });
    await newServerPid(oldPid);
    const listed = async () => (await api(base, 'GET', '/api/projects/demo/sessions')).body.some(s => s.sessionId === w.sessionId);
    await until(`session ${w.sessionId} listed after the restart`, listed, 30_000);
    const inst = await until('the session resurrected', async () => (await rows()).find(r => r.sessionId === w.sessionId), 30_000);
    await until('history paged from the jsonl', async () =>
      (await events(inst.id)).some(e => e.kind === 'text_delta' && /ready/i.test(e.text)), 30_000);
    state.sid = w.sessionId;
  });

  test('plain restart (stop-live) leaves no orphaned shells', { timeout: TURN + 60_000 }, async () => {
    assert.ok(state.sid, 'needs the resume-restart step');
    const oldPid = await healthPid(base);
    const snapshot = treeOf(await processTable(), oldPid);
    await api(base, 'POST', '/api/admin/restart', {});
    await newServerPid(oldPid);
    await assertGone(snapshot, 'the old server tree to exit', 15_000);
    const table = await processTable();
    const orphans = table.filter(p => /^(bash|sh)\.exe$/i.test(p.name) && p.created > runStart && !table.some(q => q.pid === p.ppid));
    assert.deepEqual(orphans, [], fail(`orphaned shells: ${describeProcs(orphans)}`));
  });

  test('lower-cased PROJECTS_ROOT still lists the session', { timeout: 120_000 }, async () => {
    assert.ok(state.sid, 'needs the resume-restart step');
    await stopServer();
    await launch(projects.toLowerCase());
    const r = await api(base, 'GET', '/api/projects/demo/sessions');
    assert.ok(r.body.some?.(s => s.sessionId === state.sid), `session ${state.sid} not listed under ${projects.toLowerCase()}: ${JSON.stringify(r.body)}`);
  });

  test('self-update: npm under Git Bash, restart, log continues', { timeout: 300_000 }, async () => {
    assert.ok(state.health, 'needs the boot step');
    await stopServer();
    await launch();
    const seed = path.join(work, 'seed');
    await git(work, 'clone', '-q', originDir, seed);
    // A package.json edit (depsChanged) is what makes the update run npm install.
    const pj = path.join(seed, 'package.json');
    const raw = fs.readFileSync(pj, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(raw), smokeMarker: String(Date.now()) }, null, 2).replace(/\n/g, eol) + eol);
    await git(seed, 'commit', '-q', '-am', 'smoke update');
    await git(seed, 'push', '-q', 'origin', 'HEAD:smoke');
    const newHead = await git(seed, 'rev-parse', 'HEAD');
    const st = await call('GET', '/api/settings/self-update');
    assert.ok(st.body?.updateAvailable, fail(`no update available: ${JSON.stringify(st.body)}`));
    const oldHealth = (await call('GET', '/api/health')).body;
    let body;
    try {
      const res = await fetch(`${base}/api/settings/self-update`, { method: 'POST', signal: AbortSignal.timeout(240_000) });
      body = await res.text();
    } catch (e) { assert.fail(fail(`POST self-update: ${e.message} (${e.cause?.code ?? 'no cause'})`)); }
    const result = body.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(o => o.type === 'result');
    assert.ok(result?.ok, fail(`update failed: ${body.slice(-600)}`));
    assert.ok(result.result.npm?.ran && result.result.npm?.ok, `npm install: ${JSON.stringify(result.result.npm)}`);
    assert.equal(await git(appDir, 'rev-parse', 'HEAD'), newHead);
    const mark = fs.statSync(logFile).size;
    await call('POST', '/api/admin/restart', {});
    await newServerPid(oldHealth.pid);
    const h = (await call('GET', '/api/health')).body;
    assert.notEqual(h.bootId, oldHealth.bootId);
    await until('the replacement to write server.log (inherited stdio)', () => fs.statSync(logFile).size > mark, 15_000);
  });

  test('taskkill of the server pid leaves nothing behind', { timeout: TURN + 60_000 }, async () => {
    assert.ok(state.project, 'needs the create-project step');
    // Busy, so the tree holds the tool's shell: an idle CLI exits on its own when
    // the server's death closes its stdin, and would leave nothing to leak.
    const w = await spawnWorker();
    await wsPrompt(wsUrl, w.id, 'Use the Bash tool to run `sleep 60`.');
    await waitForKind(w.id, 'tool_use', -1);
    const p = await healthPid(base);
    const snapshot = await busyTree(p);
    assert.ok(snapshot.some(q => q.pid === w.pid), `worker ${w.pid} is not in the server tree: ${describeProcs(snapshot)}`);
    await taskkillTree(p);
    await until('the server to go down', async () => (await healthPid(base)) == null, 30_000);
    await assertGone(snapshot, 'the server tree to exit', 10_000);
    const table = await processTable();
    const claudes = table.filter(q => q.name.toLowerCase() === 'claude.exe' && q.created > runStart && ours(q, table));
    assert.deepEqual(claudes, [], `claude survivors: ${describeProcs(claudes)}`);
  });

  test('no node/bash/sh/claude/conhost/cmd window handles', { timeout: 60_000 }, async () => {
    const shown = (await visibleWindows(['node', 'bash', 'sh', 'claude', 'conhost', 'cmd']))
      .filter(w => !baseline.some(b => b.pid === w.pid));
    assert.deepEqual(shown, []);
  });
});
