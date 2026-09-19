// WHAT THE ADOPT DIALOG PROMISES.
//
// It is the browser's only route into `POST /api/projects/external`. Two
// things about it are structural rather than cosmetic, and most of this file
// pins one of them:
//
//   1. The suggestion list is an INPUT HELPER for one path field — clicking a
//      row fills the field, and the submit always sends whatever is in it. So
//      "type a path yourself" is the same action, not a second flow.
//   2. Refusals arrive as 200 + {ok:false, code, reason}, so the dialog uses a
//      bare `fetch`: `apiFetch` would read a refusal as success. Every reason
//      is shown; a bare code never is.
//
// Two refusals have their remedy clause REPLACED (never stacked) because the
// server's is written for an API caller. The last test in this file is what
// stops those overrides rotting silently: it builds a REAL refusal from the
// real server functions and checks the tail the dialog strips is still there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const REAL_FETCH = globalThis.fetch;

const DIALOG_HTML = `
  <button id="adopt-project-btn"></button>
  <dialog id="adopt-project-dialog">
    <form method="dialog" id="apd-form">
      <input id="apd-name" />
      <input id="apd-path" />
      <ul id="apd-suggestions"></ul>
      <p id="apd-scan-note"></p>
      <p id="apd-error"></p>
      <menu><button value="cancel"></button><button value="adopt"></button></menu>
    </form>
    <form method="dialog" id="apd-stale" hidden>
      <p id="apd-stale-summary"></p>
      <ul id="apd-stale-discards"></ul>
      <p id="apd-stale-error"></p>
      <menu>
        <button value="cancel"></button>
        <button value="relocate"></button>
        <button value="replace"></button>
      </menu>
    </form>
  </dialog>`;

const EMPTY_SCAN = { root: '/root', maxDepth: 3, truncated: false, unreadable: 0, candidates: [] };
const tick = () => new Promise(r => setTimeout(r, 0));

// Boots the dialog against a real happy-dom document and a scripted server.
// `posts` is consumed in order — one entry per POST the flow is expected to
// make; the last entry repeats if the flow makes more.
async function bootDialog({ scan = EMPTY_SCAN, posts = [] } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  window.document.body.innerHTML = DIALOG_HTML;

  const requests = [];
  let postIdx = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/projects/suggestions')) {
      return { ok: true, status: 200, json: async () => scan };
    }
    requests.push({ url: String(url), method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    const next = posts[Math.min(postIdx++, posts.length - 1)] ?? { status: 201, body: { ok: true } };
    if (next.networkError) throw new Error(next.networkError);
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };

  const el = id => window.document.getElementById(id);
  let refreshed = 0;
  let overflowClosed = 0;
  const mod = await import(
    pathToFileURL(path.join(PUB, 'adoptProjectDialog.js')).href + `?t=${Math.random()}`);
  mod.installAdoptProjectDialog({
    dom: {
      adoptProjectBtn: el('adopt-project-btn'),
      adoptProjectDialog: el('adopt-project-dialog'),
      apdForm: el('apd-form'),
      apdStale: el('apd-stale'),
      apdName: el('apd-name'),
      apdPath: el('apd-path'),
      apdSuggestions: el('apd-suggestions'),
      apdScanNote: el('apd-scan-note'),
      apdError: el('apd-error'),
      apdStaleSummary: el('apd-stale-summary'),
      apdStaleDiscards: el('apd-stale-discards'),
      apdStaleError: el('apd-stale-error'),
    },
    refreshProjects: async () => { refreshed++; },
    closeSidebarOverflow: () => { overflowClosed++; },
  });

  el('adopt-project-btn').click();
  await tick();

  const close = async (value) => { el('adopt-project-dialog').close(value); await tick(); };
  return {
    el, requests, messageFor: mod.messageFor, overrides: mod.REFUSAL_OVERRIDES,
    close,
    counts: () => ({ refreshed, overflowClosed }),
    state: () => ({
      formHidden: el('apd-form').hidden,
      staleHidden: el('apd-stale').hidden,
      error: el('apd-error').textContent,
      staleError: el('apd-stale-error').textContent,
      staleSummary: el('apd-stale-summary').textContent,
      staleDiscards: el('apd-stale-discards').textContent,
    }),
  };
}

const scanWith = (...candidates) => ({ ...EMPTY_SCAN, candidates });

const STALE_BODY = {
  ok: false, code: 'PROJECT_EXISTS_STALE',
  reason: "project 'api' is registered at /old/api, which no longer exists.",
  heldPath: '/old/api',
  discards: { attachments: 2, debug: 5, worktrees: 1 },
};

// PINS: the suggestion list is an INPUT HELPER, not a second endpoint — a
// click fills BOTH fields, and what reaches the server is the clicked path.
test('clicking a suggestion fills both fields and the POST carries that path', async () => {
  const d = await bootDialog({
    scan: scanWith({ path: '/root/work/api', relPath: 'work/api', depth: 2, isGitRepo: true, suggestedName: 'api' }),
  });
  const row = d.el('apd-suggestions').querySelector('button');
  assert.ok(row, 'the candidate is rendered as a clickable row');
  row.click();
  assert.equal(d.el('apd-path').value, '/root/work/api');
  assert.equal(d.el('apd-name').value, 'api');

  await d.close('adopt');
  assert.equal(d.requests.length, 1);
  assert.equal(d.requests[0].body.path, '/root/work/api');
  assert.equal(d.counts().refreshed, 1, 'a successful adopt refreshes the sidebar');
});

// PINS: ONE submit path. A hand-typed path goes to the same URL with the same
// body shape and no extra field — which is what makes "the same action, not a
// separate flow" true rather than merely claimed.
test('a hand-typed path uses the same request as a clicked suggestion', async () => {
  const clicked = await bootDialog({
    scan: scanWith({ path: '/root/api', relPath: 'api', depth: 1, isGitRepo: false, suggestedName: 'api' }),
  });
  clicked.el('apd-suggestions').querySelector('button').click();
  await clicked.close('adopt');

  const typed = await bootDialog();
  typed.el('apd-name').value = 'api';
  typed.el('apd-path').value = '/root/api';
  await typed.close('adopt');

  assert.deepEqual(typed.requests, clicked.requests);
  assert.deepEqual(typed.requests[0], {
    url: '/api/projects/external', method: 'POST',
    body: { name: 'api', path: '/root/api' },
  });
});

// PINS: a collision with a record that STILL RESOLVES is an ordinary
// collision — the relocate/replace choice belongs to a stale record alone, and
// offering it here would let a user discard a live project's stored state.
test('PROJECT_EXISTS reopens the form and offers no relocate/replace pane', async () => {
  const d = await bootDialog({
    posts: [{ status: 200, body: { ok: false, code: 'PROJECT_EXISTS', reason: "project 'api' already exists at /srv/api." } }],
  });
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/root/api';
  await d.close('adopt');
  const s = d.state();
  assert.equal(s.formHidden, false, 'the form is back up');
  assert.equal(s.staleHidden, true, 'and the stale pane is not');
  assert.match(s.error, /already exists at \/srv\/api/);
  assert.equal(d.counts().refreshed, 0);
});

// PINS: the stale pane names WHERE the held record points and WHAT a Replace
// would discard — all three counts, because a user authorising a discard has
// to be told what is at stake.
test('PROJECT_EXISTS_STALE shows the stale pane naming heldPath and every discard count', async () => {
  const d = await bootDialog({ posts: [{ status: 200, body: STALE_BODY }] });
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/root/api';
  await d.close('adopt');
  const s = d.state();
  assert.equal(s.staleHidden, false);
  assert.equal(s.formHidden, true);
  assert.match(s.staleSummary, /\/old\/api/);
  assert.match(s.staleDiscards, /2/);
  assert.match(s.staleDiscards, /5/);
  assert.match(s.staleDiscards, /1/);
});

// PINS: the dialog WIRES TO the server's stale branch rather than
// reimplementing it — each button re-POSTs the original name and path with the
// matching `onStaleRecord`.
test('Relocate and Replace re-POST the same target with their onStaleRecord', async () => {
  for (const action of ['relocate', 'replace']) {
    const d = await bootDialog({ posts: [{ status: 200, body: STALE_BODY }, { status: 201, body: { ok: true } }] });
    d.el('apd-name').value = 'api';
    d.el('apd-path').value = '/root/api';
    await d.close('adopt');
    await d.close(action);
    assert.equal(d.requests.length, 2, `${action}: a second POST was sent`);
    assert.deepEqual(d.requests[1].body,
      { name: 'api', path: '/root/api', onStaleRecord: action });
    assert.equal(d.counts().refreshed, 1, `${action}: the successful retry refreshed the sidebar`);
  }
});

// PINS: AC5 for the cross-kind relocate refusal. It arrives only from a
// Relocate, so the STALE pane stays up and Replace — the remedy the refusal
// names — is still one click away, and the message carries no API vocabulary.
test('PROJECT_PLACEMENT_IN_USE renders on the stale pane and names no protocol field', async () => {
  const reason = "project 'api' cannot be relocated while it has 1 registered worktree(s): feature. "
    + "A worktree on a system re-derives its path from this project's, and its checkout does not move"
    + " — delete them first, or pass onStaleRecord:'replace' to discard them along with the rest of its stored state.";
  const d = await bootDialog({
    posts: [
      { status: 200, body: STALE_BODY },
      { status: 200, body: { ok: false, code: 'PROJECT_PLACEMENT_IN_USE', reason } },
    ],
  });
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/root/api';
  await d.close('adopt');
  await d.close('relocate');
  const s = d.state();
  assert.equal(s.staleHidden, false, 'the stale pane stays up, so Replace is one click away');
  assert.match(s.staleError, /feature/, 'the refusal still names what blocks it');
  assert.match(s.staleError, /choose Replace below/);
  assert.ok(!s.staleError.includes('onStaleRecord'), 'no API vocabulary reaches the user');
});

// PINS: the ONE-REMEDY rule. The override REPLACES the server's remedy clause
// rather than stacking a second one below it — two contradictory remedies are
// worse than either alone, and "Pick another name" is simply wrong on the
// adopt path (the transcript directory is keyed on the cwd, which the project
// name never enters).
test('TRANSCRIPT_DIR_COLLISION swaps the remedy clause instead of stacking one', async () => {
  const reason = "cannot register project 'api': its working directory would be '/root/api', "
    + "which is already project 'other''s. Two places in one directory share a transcript "
    + 'directory, and their sessions interleave in it. Pick another name.';
  const d = await bootDialog({
    posts: [{ status: 200, body: { ok: false, code: 'TRANSCRIPT_DIR_COLLISION', reason } }],
  });
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/root/api';
  await d.close('adopt');
  const s = d.state();
  assert.equal(s.formHidden, false);
  assert.match(s.error, /Pick a different directory/);
  assert.ok(!s.error.includes('Pick another name'),
    'the server remedy is replaced, not left standing beside the new one');
  assert.match(s.error, /already project 'other''s/, 'and everything before the remedy survives');
});

// PINS: the fail-safe. A server sentence that no longer ends with the known
// tail degrades to the server's OWN wording — never to a mangled one — which
// is what makes the byte-exact tail safe to hardcode.
test("a reason lacking the known tail renders verbatim", async () => {
  const reason = 'cannot register project \'api\': something new the dialog has never seen.';
  const d = await bootDialog({
    posts: [{ status: 200, body: { ok: false, code: 'TRANSCRIPT_DIR_COLLISION', reason } }],
  });
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/root/api';
  await d.close('adopt');
  assert.equal(d.state().error, reason);
  assert.equal(d.messageFor({ code: 'TRANSCRIPT_DIR_COLLISION', reason }), reason);
});

// PINS: the pass-through rows PASS THROUGH rather than being dropped, and a
// raw code is never what the user is shown. Each of these reasons already
// names its own next action.
test('the pass-through refusals render their reason and never a bare code', async () => {
  const rows = [
    { code: 'TARGET_ALREADY_MANAGED', reason: "'/root/api' is already adopted as project 'api'." },
    { code: 'TARGET_IS_CC_STATE', reason: "'/root/.plugins/x' is inside '/root/.plugins', which is code-conductor's own state — adopt a directory cc does not manage." },
    { code: 'PROJECT_EXISTS_UNRESOLVABLE', reason: "project 'api' already exists at /srv/api, and cc could not ask its system whether that is still there. Fix the system, or delete the project to unregister the name." },
    { code: 'TARGET_INSIDE_REPO', reason: "'/root/api/src' is inside the git repository whose toplevel is '/root/api' — adopt that instead." },
    { code: 'TARGET_NOT_FOUND', reason: "cannot resolve '/nope': ENOENT" },
  ];
  for (const row of rows) {
    const d = await bootDialog({ posts: [{ status: 200, body: { ok: false, ...row } }] });
    d.el('apd-name').value = 'api';
    d.el('apd-path').value = '/root/api';
    await d.close('adopt');
    const s = d.state();
    assert.equal(s.error, row.reason, `${row.code} renders its reason verbatim`);
    assert.equal(s.staleHidden, true, `${row.code} is not a relocate/replace choice`);
    assert.ok(!s.error.includes(row.code), `${row.code} is never shown as a bare code`);
  }
});

// PINS: hard errors and soft refusals are BOTH handled — and a 200 refusal is
// never read as success, which is why this dialog does not use apiFetch.
test('a non-2xx {error} body is shown and the form reopens', async () => {
  const d = await bootDialog({ posts: [{ status: 500, body: { error: 'boom' } }] });
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/root/api';
  await d.close('adopt');
  assert.equal(d.state().error, 'boom');
  assert.equal(d.state().formHidden, false);
  assert.equal(d.counts().refreshed, 0);

  const thrown = await bootDialog({ posts: [{ networkError: 'offline' }] });
  thrown.el('apd-name').value = 'api';
  thrown.el('apd-path').value = '/root/api';
  await thrown.close('adopt');
  assert.equal(thrown.state().error, 'offline');
  assert.equal(thrown.state().formHidden, false);
});

// PINS: a truncated or partly-unreadable scan SAYS SO. Without it, "the
// directory is not in the list" would read as "cc looked and it is not
// adoptable", which a capped walk does not entitle the user to conclude.
test('the scan note reports truncation and unreadable directories', async () => {
  const quiet = await bootDialog();
  assert.ok(!/truncat/i.test(quiet.el('apd-scan-note').textContent),
    'a complete scan does not warn');

  const noisy = await bootDialog({
    scan: { ...EMPTY_SCAN, truncated: true, unreadable: 3 },
  });
  const note = noisy.el('apd-scan-note').textContent;
  assert.match(note, /truncat/i);
  assert.match(note, /3/);
});

// PINS: THE OVERRIDE CANNOT ROT SILENTLY. Both replacements are keyed on a
// literal tail of a sentence the SERVER builds by `+` concatenation across
// source lines; if either sentence changes, the fail-safe above hides the
// breakage by rendering the server's wording, and the override would look
// implemented while never running. So this test builds both refusals from the
// real functions — not from a hand-written string — and checks the dialog's
// tails still match.
test('the overridden refusals still end with the exact tails the dialog strips', async () => {
  globalThis.fetch = REAL_FETCH;
  const mod = await import(pathToFileURL(path.join(PUB, 'adoptProjectDialog.js')).href);
  const tailFor = code => mod.REFUSAL_OVERRIDES.find(o => o.code === code)?.serverTail;

  // ── TRANSCRIPT_DIR_COLLISION, from the real sentence builder.
  const { transcriptCollisionReason } = await import('../src/systems/transcriptKey.ts');
  const candidate = { project: 'p', worktree: null, system: 'local', remoteId: null, cwd: '/srv/a' };
  const real = transcriptCollisionReason("project 'p'", candidate, { ...candidate, project: 'q', samePath: true });
  const transcriptTail = tailFor('TRANSCRIPT_DIR_COLLISION');
  assert.ok(real.endsWith(transcriptTail),
    `the dialog strips ${JSON.stringify(transcriptTail)} but the server now says ${JSON.stringify(real)}`);
  assert.ok(!mod.messageFor({ code: 'TRANSCRIPT_DIR_COLLISION', reason: real }).endsWith(transcriptTail),
    'and the override actually fires on the real sentence');

  // ── PROJECT_PLACEMENT_IN_USE, from a real refused relocate. It needs a
  // CROSS-KIND move of a project whose record is stale and whose worktrees are
  // registered, so the fixture registers a reachable system and adopts there.
  const { freshProjectsRoot, rmrf } = await import('./helpers.mjs');
  const { bindRemoteSystem, seedRepo } = await import('./remoteSystem.mjs');
  const { adoptProject } = await import('../src/projects.ts');
  const { createWorktree } = await import('../src/worktrees.ts');
  const { disposeSystemHandles } = await import('../src/systems/registry.ts');

  const { home } = await freshProjectsRoot();
  try {
    const remote = await bindRemoteSystem();
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    await createWorktree('app', { name: 'feature' });
    await fs.rm(tree, { recursive: true, force: true });
    const moved = await seedRepo(path.join(remote.root, 'app-moved'));

    const refused = await adoptProject('app', moved, { system: remote.id, onStaleRecord: 'relocate' });
    assert.equal(refused.code, 'PROJECT_PLACEMENT_IN_USE', JSON.stringify(refused));
    const placementTail = tailFor('PROJECT_PLACEMENT_IN_USE');
    assert.ok(refused.reason.endsWith(placementTail),
      `the dialog strips ${JSON.stringify(placementTail)} but the server now says ${JSON.stringify(refused.reason)}`);
    const shown = mod.messageFor(refused);
    assert.ok(!shown.includes('onStaleRecord'), 'the override actually fires on the real sentence');
    assert.match(shown, /choose Replace below/);
  } finally {
    disposeSystemHandles();
    await rmrf(home);
  }
});
