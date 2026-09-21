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
      <select id="apd-system"></select>
      <p id="apd-system-note"></p>
      <label id="apd-remote-row" hidden><input id="apd-remote" /></label>
      <input id="apd-path" />
      <ul id="apd-suggestions" hidden></ul>
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

// Same three rows tests/new-project-placement.test.mjs uses, so both dialogs are
// judged against one registry: the built-in local row, one reachable system, and
// one with no provider command.
const SYSTEMS = [
  { id: 'local', label: 'This machine', managed: true },
  { id: 'prod-box', label: 'Prod box', managed: false, launch: ['ssh', 'prod', 'p'] },
  { id: 'namedonly', label: 'Named only', managed: false },
];
const tick = () => new Promise(r => setTimeout(r, 0));

// Boots the dialog against a real happy-dom document and a scripted server.
// `posts` is consumed in order — one entry per POST the flow is expected to
// make; the last entry repeats if the flow makes more.
async function bootDialog({ scan = EMPTY_SCAN, scanStatus = 200, posts = [], systems = SYSTEMS, systemsStatus = 200 } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  window.document.body.innerHTML = DIALOG_HTML;

  const requests = [];
  let scans = 0;
  let postIdx = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/projects/suggestions')) {
      scans++;
      return { ok: scanStatus < 400, status: scanStatus, json: async () => scan };
    }
    // Before the catch-all: the registry is a GET, and recording it as a
    // request would corrupt every POST-count assertion in this file.
    if (String(url).includes('/api/settings/systems')) {
      return { ok: systemsStatus < 400, status: systemsStatus, json: async () => ({ systems }) };
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
      apdSystem: el('apd-system'),
      apdSystemNote: el('apd-system-note'),
      apdRemote: el('apd-remote'),
      apdRemoteRow: el('apd-remote-row'),
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
  // Choosing a placement the way a user does — the module listens for `change`,
  // not for the property write.
  const pick = async (id) => {
    el('apd-system').value = id;
    el('apd-system').dispatchEvent(new window.Event('change'));
    await tick();
  };
  const typeRemote = async (v) => {
    el('apd-remote').value = v;
    el('apd-remote').dispatchEvent(new window.Event('input'));
    await tick();
  };
  return {
    el, window, requests, messageFor: mod.messageFor, overrides: mod.REFUSAL_OVERRIDES,
    close, pick, typeRemote, scans: () => scans,
    reopen: async () => { el('adopt-project-btn').click(); await tick(); },
    counts: () => ({ refreshed, overflowClosed }),
    // The discard list read as ROWS. Reading its concatenated textContent
    // would let a count/noun swap pass: "2 attachments, 5 debug captures" and
    // "5 attachments, 2 debug captures" contain the same digits.
    discardRows: () => [...el('apd-stale-discards').querySelectorAll('li')].map(li => li.textContent),
    state: () => ({
      formHidden: el('apd-form').hidden,
      staleHidden: el('apd-stale').hidden,
      error: el('apd-error').textContent,
      staleError: el('apd-stale-error').textContent,
      staleSummary: el('apd-stale-summary').textContent,
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
// would discard. This is AC4's whole substance — the user is authorising a
// destructive action on the strength of this list — so each count is pinned
// TO ITS NOUN, not merely present among the digits, and both grammatical
// branches are exercised: a list that said "5 attachments" for 2 of them, or
// "1 worktree registrations", would be lying about what is at stake.
test('PROJECT_EXISTS_STALE shows the stale pane naming heldPath and pairing every discard count with what it counts', async () => {
  const d = await bootDialog({ posts: [{ status: 200, body: STALE_BODY }] });
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/root/api';
  await d.close('adopt');
  const s = d.state();
  assert.equal(s.staleHidden, false);
  assert.equal(s.formHidden, true);
  assert.match(s.staleSummary, /\/old\/api/);
  assert.deepEqual(d.discardRows(),
    ['2 attachments', '5 debug captures', '1 worktree registration'],
    'each count sits with the noun it counts, and 1 is singular');

  // The complementary grammatical branch on each row, plus a zero — which
  // must still be SHOWN: "0 worktree registrations" is the reassurance that
  // nothing of that kind is at stake, and an omitted row says nothing at all.
  const other = await bootDialog({
    posts: [{ status: 200, body: { ...STALE_BODY, discards: { attachments: 1, debug: 0, worktrees: 2 } } }],
  });
  other.el('apd-name').value = 'api';
  other.el('apd-path').value = '/root/api';
  await other.close('adopt');
  assert.deepEqual(other.discardRows(),
    ['1 attachment', '0 debug captures', '2 worktree registrations']);
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
    // The two the placement adds. Both already name their next action, which is
    // why REFUSAL_OVERRIDES stays at two rows.
    { code: 'SYSTEM_UNREACHABLE', reason: "could not resolve '/srv/api' on system 'prod-box': connect ECONNREFUSED" },
    { code: 'INVALID_REMOTE_ID', reason: 'invalid remoteId "a b" — whitespace and control characters are not allowed' },
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
test('the scan note reports truncation and the unreadable count', async () => {
  const candidates = [{ path: '/root/a', relPath: 'a', depth: 1, isGitRepo: false, suggestedName: 'a' }];
  const quiet = await bootDialog({ scan: { ...EMPTY_SCAN, candidates } });
  const quietNote = quiet.el('apd-scan-note').textContent;
  assert.ok(!/truncat/i.test(quietNote), 'a complete scan does not warn');
  assert.ok(!/could not be read/.test(quietNote), 'nor does it mention unreadable directories');

  // Candidates are present here deliberately: a bare digit match would
  // otherwise be discriminating only by accident of the empty-list wording.
  // The count is pinned to the clause it belongs to, and to its own plural.
  const noisy = await bootDialog({
    scan: { ...EMPTY_SCAN, candidates, truncated: true, unreadable: 3 },
  });
  const note = noisy.el('apd-scan-note').textContent;
  assert.match(note, /truncat/i);
  assert.match(note, /3 directories could not be read/);

  const one = await bootDialog({ scan: { ...EMPTY_SCAN, candidates, unreadable: 1 } });
  assert.match(one.el('apd-scan-note').textContent, /1 directory could not be read/);
});

// PINS (1) the empty-scan note POINTS AT THE FREE-TEXT FIELD, and says the
// field reaches anywhere. When the scan finds nothing this sentence is the
// ONLY thing on screen telling the user there is still a way in — and the way
// it names is AC2's route to a directory outside the projects root, which the
// scan structurally cannot offer. A note trimmed to "type a path below" leaves
// the reader believing cc adopts only what it just failed to find.
//
// PINS (2) the count clause agrees with its count. "1 unregistered
// directories" is the branch nothing else reads.
test('the scan note names the free-text route when empty, and pluralises its count', async () => {
  const empty = await bootDialog({ scan: { ...EMPTY_SCAN, root: '/root', candidates: [] } });
  const emptyNote = empty.el('apd-scan-note').textContent;
  assert.match(emptyNote, /No unregistered directories found under \/root/);
  assert.match(emptyNote, /type a path below to adopt one from anywhere/,
    'the empty note must still offer the field, and say it reaches anywhere');

  const cand = n => Array.from({ length: n }, (_, i) => (
    { path: `/root/d${i}`, relPath: `d${i}`, depth: 1, isGitRepo: false, suggestedName: `d${i}` }));

  const one = await bootDialog({ scan: { ...EMPTY_SCAN, candidates: cand(1) } });
  assert.match(one.el('apd-scan-note').textContent, /\b1 unregistered directory under\b/);

  const two = await bootDialog({ scan: { ...EMPTY_SCAN, candidates: cand(2) } });
  assert.match(two.el('apd-scan-note').textContent, /\b2 unregistered directories under\b/);
});

// PINS (3): a `.git`-bearing row WEARS its badge. The badge is the only
// visible expression of the `.git`-first ranking — drop it and the order is
// still correct while the user cannot see why the top rows are the top rows.
// Both branches, so a badge on every row fails too.
test('a git-bearing candidate renders its badge and a plain one does not', async () => {
  const d = await bootDialog({
    scan: scanWith(
      { path: '/root/repo', relPath: 'repo', depth: 1, isGitRepo: true, suggestedName: 'repo' },
      { path: '/root/plain', relPath: 'plain', depth: 1, isGitRepo: false, suggestedName: 'plain' },
    ),
  });
  const rows = [...d.el('apd-suggestions').querySelectorAll('button.apd-suggestion')];
  assert.equal(rows.length, 2);
  const badgeOf = row => row.querySelector('.apd-suggestion-badge');
  assert.equal(badgeOf(rows[0])?.textContent, 'git', 'the repo row is marked as one');
  assert.equal(badgeOf(rows[1]), null, 'and the plain row carries no badge');
  assert.match(rows[1].textContent, /plain/, 'which is not the same as rendering nothing');
});

// PINS (4): A SCAN THAT DID NOT RUN MUST NOT LOOK LIKE A SCAN THAT FOUND
// NOTHING. Without the `!res.ok` throw the error body falls through to the
// renderer, which finds no `candidates` and prints the ordinary empty-scan
// note — telling the user "there is nothing here to adopt" when the truth is
// "cc never looked". The note must say so, name the status, and still point at
// the field, since the free-text route is unaffected by a failed scan.
test('a failed suggestions fetch says the scan did not run, not that it found nothing', async () => {
  const d = await bootDialog({ scanStatus: 500, scan: { error: 'boom' } });
  const note = d.el('apd-scan-note').textContent;
  assert.match(note, /Could not scan for directories/);
  assert.match(note, /500/, 'and names what went wrong');
  assert.ok(!/No unregistered directories found/.test(note),
    'a scan that failed must never render as a scan that came back empty');
  assert.match(note, /type a path below/, 'the free-text route survives a failed scan');
  assert.equal(d.el('apd-suggestions').children.length, 0);

  // The dialog still WORKS without its list — the failure costs the
  // suggestions, never the affordance.
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/elsewhere/api';
  await d.close('adopt');
  assert.deepEqual(d.requests[0].body, { name: 'api', path: '/elsewhere/api' });
});


// ─────────────────────────────────────────────────────────────────────────────
// PLACEMENT. The tree being adopted can already live on a registered system, so
// the dialog chooses the machine before it asks for the path on it. Everything
// below is about keeping one promise: what the dialog shows is about the machine
// it is going to send.

// PINS: only systems cc can actually reach are offered, and local is the
// default. A registry row with no provider command would register a project
// every later operation refuses.
test('the system picker offers local plus reachable systems only, and defaults to local', async () => {
  const d = await bootDialog();
  assert.deepEqual([...d.el('apd-system').options].map(o => o.value), ['local', 'prod-box']);
  assert.equal(d.el('apd-system').value, 'local');
  assert.equal([...d.el('apd-system').options].find(o => o.value === 'prod-box').textContent,
    'Prod box (prod-box)', 'a user row is named by label AND id, as the create dialog names it');
});

// PINS: the local body, byte for byte. The placement keys must not leak onto a
// request that chose none: `{name, path, system: null}` is a different request
// on the wire from `{name, path}`, and the local adopt is the one flow this
// change must leave untouched.
test('a local adopt posts exactly {name, path}', async () => {
  const d = await bootDialog();
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/root/api';
  await d.close('adopt');
  assert.deepEqual(d.requests[0].body, { name: 'api', path: '/root/api' });
});

// PINS: the list is shown only for the placement it is ABOUT. It is a scan of
// cc's own disk, so offering it while the path field means a path on another
// machine would name directories that do not exist there — and coming back to
// local must restore the note the scan produced, without scanning again.
test('choosing a system hides the local list, reveals the target field, and retargets the hint — and going back restores both', async () => {
  const d = await bootDialog({
    scan: scanWith({ path: '/root/api', relPath: 'api', depth: 1, isGitRepo: false, suggestedName: 'api' }),
  });
  const localNote = d.el('apd-scan-note').textContent;
  assert.match(localNote, /1 unregistered directory/, 'the local scan spoke first');
  assert.equal(d.el('apd-suggestions').hidden, false);
  assert.equal(d.el('apd-remote-row').hidden, true, 'this machine has no target to name');

  await d.pick('prod-box');
  assert.equal(d.el('apd-suggestions').hidden, true, 'a scan of cc\'s disk is not about prod-box');
  assert.equal(d.el('apd-remote-row').hidden, false);
  assert.match(d.el('apd-scan-note').textContent, /system 'prod-box'/);
  assert.match(d.el('apd-scan-note').textContent, /cc cannot list directories there/);

  await d.pick('local');
  assert.equal(d.el('apd-suggestions').hidden, false, 'the list comes back');
  assert.equal(d.el('apd-remote-row').hidden, true);
  assert.equal(d.el('apd-scan-note').textContent, localNote,
    'and the note the scan produced comes back verbatim');
  assert.equal(d.scans(), 1, 'restoring the local view costs no second scan');
});

// PINS: the hint names the TARGET, not merely the system. On a system serving
// many named targets, a hint naming only the system points at the wrong machine
// — the same vocabulary the server uses in its own refusals.
test('the placement hint names the target, not just the system', async () => {
  const d = await bootDialog();
  await d.pick('prod-box');
  await d.typeRemote('ctr7');
  assert.match(d.el('apd-scan-note').textContent, /remote 'ctr7' of system 'prod-box'/);
});

// PINS: the placement reaches the server as the two fields the route reads, and
// the target is trimmed the way the create dialog trims it.
test('a remote adopt posts system + remoteId, trimmed', async () => {
  const d = await bootDialog();
  d.el('apd-name').value = 'api';
  await d.pick('prod-box');
  await d.typeRemote(' ctr_7.a ');
  d.el('apd-path').value = '/srv/api';
  await d.close('adopt');
  assert.deepEqual(d.requests[0].body,
    { name: 'api', path: '/srv/api', system: 'prod-box', remoteId: 'ctr_7.a' });
});

// PINS: absence stays absence. A blank target IS an answer — the provider's own
// default — and posting `remoteId: ""` would name a target called nothing.
test('a remote adopt with a blank target posts no remoteId', async () => {
  const d = await bootDialog();
  d.el('apd-name').value = 'api';
  await d.pick('prod-box');
  await d.typeRemote('   ');
  d.el('apd-path').value = '/srv/api';
  await d.close('adopt');
  assert.deepEqual(d.requests[0].body, { name: 'api', path: '/srv/api', system: 'prod-box' });
});

// PINS: the dialog refuses a relative path on a system ITSELF, without a round
// trip — the server says the same thing, but only after the dialog has closed.
test('a relative path on a system is refused in the dialog, before any request', async () => {
  const d = await bootDialog();
  d.el('apd-name').value = 'api';
  await d.pick('prod-box');
  d.el('apd-path').value = 'srv/api';
  await d.close('adopt');
  assert.equal(d.requests.length, 0, 'nothing was posted');
  assert.match(d.state().error, /absolute/i);
  assert.match(d.state().error, /prod-box/, 'and names the machine the path is about');
  assert.equal(d.state().formHidden, false, 'the form reopens so the user can fix it');
});

// PINS: the complement, and the reason the check is GATED. A local adopt still
// surfaces exactly the refusals it did before — a blanket client-side check
// would satisfy the test above while silently changing local behaviour.
test('a relative path with no system still reaches the server', async () => {
  const d = await bootDialog({
    posts: [{ status: 200, body: { ok: false, code: 'INVALID_TARGET_PATH', reason: 'path must be a non-empty absolute path.' } }],
  });
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = 'srv/api';
  await d.close('adopt');
  assert.deepEqual(d.requests[0].body, { name: 'api', path: 'srv/api' });
  assert.match(d.state().error, /absolute path/, "and the server's own refusal is what is shown");
});

// PINS: the whole target rides on `pending`. The relocate/replace buttons
// re-send it after the form pane is hidden, so the picker is MOVED BACK TO
// LOCAL between the two closes — which is what makes "carried on `pending`" and
// "read off the form at submit time" produce different bodies. Reading the form
// would not even get that far: the switch also cleared the path, so submit()
// returns at its `!target.path` guard and no second POST is sent at all.
test('the stale round-trip re-sends the placement the first POST carried, not the form', async () => {
  const d = await bootDialog({ posts: [{ status: 200, body: STALE_BODY }, { status: 201, body: { ok: true } }] });
  d.el('apd-name').value = 'api';
  await d.pick('prod-box');
  await d.typeRemote('ctr7');
  d.el('apd-path').value = '/srv/api';
  await d.close('adopt');

  await d.pick('local');
  assert.equal(d.el('apd-path').value, '', 'the switch emptied the form the retry must not read');

  await d.close('relocate');
  assert.equal(d.requests.length, 2);
  assert.deepEqual(d.requests[1].body,
    { name: 'api', path: '/srv/api', system: 'prod-box', remoteId: 'ctr7', onStaleRecord: 'relocate' });
});


// PINS: A PATH IS ABOUT ONE MACHINE. Left standing across a placement switch it
// is posted as a path on the other one — either a refusal naming a path the
// user never typed, or a silent adoption of a different tree under that name.
// Both directions, and a list-deposited path is no different from a typed one:
// the rule is the field's meaning, not the value's provenance.
test('changing the placement clears the path, whichever way it changes and however it got there', async () => {
  const clicked = await bootDialog({
    scan: scanWith({ path: '/root/work/api', relPath: 'work/api', depth: 2, isGitRepo: true, suggestedName: 'api' }),
  });
  clicked.el('apd-suggestions').querySelector('button').click();
  assert.equal(clicked.el('apd-path').value, '/root/work/api');
  await clicked.pick('prod-box');
  assert.equal(clicked.el('apd-path').value, '',
    'a directory the local scan found is not a path on prod-box');
  await clicked.close('adopt');
  assert.equal(clicked.requests.length, 0, 'and an empty path submits nothing');

  const typed = await bootDialog();
  await typed.pick('prod-box');
  typed.el('apd-path').value = '/srv/api';
  await typed.pick('local');
  assert.equal(typed.el('apd-path').value, '',
    'nor is a path on prod-box a path on this machine');
});

// PINS: the clear is keyed to the SYSTEM changing, not to syncPlacement running.
// syncPlacement also runs on every Remote keystroke, on open, and after a scan —
// wiring the clear inside it would empty the field under the user's hands while
// they name a target for the placement the path already belongs to.
test('naming a target does not disturb the path', async () => {
  const d = await bootDialog();
  await d.pick('prod-box');
  d.el('apd-path').value = '/srv/api';
  await d.typeRemote('ctr7');
  assert.equal(d.el('apd-path').value, '/srv/api');
  assert.match(d.el('apd-scan-note').textContent, /remote 'ctr7'/, 'the hint did track it');
});

// PINS: an error names a placement, and does not outlive it. Left standing it
// accuses the field of a fault the machine it now refers to never had.
test('changing the placement clears the error the previous one raised', async () => {
  const d = await bootDialog();
  d.el('apd-name').value = 'api';
  await d.pick('prod-box');
  d.el('apd-path').value = 'srv/api';
  await d.close('adopt');
  assert.match(d.state().error, /prod-box/);

  await d.pick('local');
  assert.equal(d.state().error, '');
});


// PINS: REOPENING THE DIALOG CARRIES NOTHING OVER FROM THE PREVIOUS OPEN. Every
// other test in this file opens it once, so the whole reset in the open handler
// sits unexercised — and each field it forgets is one the user abandoned on a
// previous attempt, silently riding out on the next POST. The Remote target is
// the sharpest: nothing else in the module ever writes that field (buildSystems
// resets the picker but not the target, syncPlacement only reads it), so a
// dropped reset there is permanent for the life of the page.
test('reopening the dialog resets every field the previous open left behind', async () => {
  const d = await bootDialog({
    posts: [{ status: 200, body: { ok: false, code: 'PROJECT_EXISTS', reason: "project 'api' already exists at /srv/api." } }],
  });
  d.el('apd-name').value = 'api';
  await d.pick('prod-box');
  await d.typeRemote('ctr7');
  d.el('apd-path').value = '/srv/api';
  await d.close('adopt');
  assert.match(d.state().error, /already exists/, 'the first attempt left an error standing');
  await d.close('cancel'); // the user gives up on that attempt

  await d.reopen();
  assert.equal(d.el('apd-name').value, '');
  assert.equal(d.el('apd-path').value, '');
  assert.equal(d.el('apd-remote').value, '', 'an abandoned target must not ride out on the next adopt');
  assert.equal(d.el('apd-system').value, 'local');
  assert.equal(d.state().error, '');
  assert.equal(d.el('apd-remote-row').hidden, true, 'and the form is laid out for the placement it reset to');
  assert.equal(d.el('apd-suggestions').hidden, false);

  // The reset is what the POST is made of, not merely what the form shows.
  d.el('apd-name').value = 'other';
  d.el('apd-path').value = '/root/other';
  await d.close('adopt');
  assert.deepEqual(d.requests.at(-1).body, { name: 'other', path: '/root/other' });
});

// PINS: an unreadable registry SAYS SO. Falling through silently to a local-only
// picker makes "cc could not ask" indistinguishable from "nothing is
// registered", and the user would read the missing system as one they never
// added. The complement is the other half of that distinction: a registry that
// answers with only the local row says nothing at all.
test('an unreadable registry says so and still offers this machine', async () => {
  const d = await bootDialog({ systemsStatus: 500 });
  assert.deepEqual([...d.el('apd-system').options].map(o => o.value), ['local']);
  assert.match(d.el('apd-system-note').textContent, /Could not read the systems registry/);
  assert.match(d.el('apd-system-note').textContent, /500/, 'and names what went wrong');

  // The failure costs the picker's extra rows, never the dialog.
  d.el('apd-name').value = 'api';
  d.el('apd-path').value = '/root/api';
  await d.close('adopt');
  assert.deepEqual(d.requests[0].body, { name: 'api', path: '/root/api' });

  const quiet = await bootDialog({ systems: [{ id: 'local', label: 'This machine', managed: true }] });
  assert.deepEqual([...quiet.el('apd-system').options].map(o => o.value), ['local']);
  assert.equal(quiet.el('apd-system-note').textContent, '',
    'a registry that answered, holding only this machine, has nothing to report');
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
  // What the user is SHOWN for the real sentence — not merely that the tail is
  // gone. A remedy that stripped and replaced with nothing would satisfy the
  // endsWith check alone while leaving the user no next action at all.
  const shownTranscript = mod.messageFor({ code: 'TRANSCRIPT_DIR_COLLISION', reason: real });
  assert.ok(!shownTranscript.includes('Pick another name'),
    'the server remedy is gone from the real sentence');
  assert.match(shownTranscript, /Pick a different directory/,
    'and the replacement is what stands in its place');
  assert.ok(shownTranscript.startsWith(real.slice(0, -transcriptTail.length)),
    'everything the server said before the remedy survives verbatim');

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
