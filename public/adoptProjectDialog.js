// Adopt-directory dialog: the sidebar ≡ "+ Adopt directory" button, the
// suggestion list from `GET /api/projects/suggestions`, the adopt POST, and
// the relocate/replace choice a stale record offers.
//
// ONE ACTION, STRUCTURALLY. The suggestion list is an INPUT HELPER for the
// single path field — a row's click fills the field (and the name), and the
// submit always sends whatever is in it. There is no second code path for a
// hand-typed path, which is what makes "the same action, not a separate flow"
// true rather than merely claimed. The list is SHOWN only for the local
// placement, because it is a scan of cc's own disk; that changes which
// placement it is offered for, not what it is.
//
// PLACEMENT. The tree may already live on a registered SYSTEM, so the machine
// is chosen before the path on it — only systems cc can reach are offered,
// since a project on an unreachable row is one every later operation refuses.
// A non-local system also offers a `remoteId`, UNCONDITIONALLY rather than
// gated on the provider's `remotes` capability: cc cannot know that without
// connecting, and the server's named refusal at adopt time is what answers it.
// Blank means the provider's own default target, so the field is omitted
// rather than sent empty. When the system's provider lists the remotes it is
// configured for, the field is a dropdown of them instead — see the Remote
// block below.
//
// BARE `fetch`, NOT `apiFetch`. `POST /api/projects/external` answers 200 +
// {ok:false, code, reason} for every refusal, and `http.js`'s apiFetch would
// read that as success. Same reason projectRemoteDialog.js uses a bare fetch.
//
// Follows the installX({...}) pattern. No returned handle — it opens from a
// fixed button, like newProjectDialog.js.
//
// Injected interface:
//   - dom: { adoptProjectBtn, adoptProjectDialog, apdForm, apdStale, apdName,
//            apdSystem, apdSystemNote, apdRemote, apdRemoteRow, apdRemoteSelect,
//            apdRemoteNote, apdPath,
//            apdPathCompletions, apdPathNote, apdSuggestions, apdScanNote, apdError, apdStaleSummary,
//            apdStaleDiscards, apdStaleError } els.
//   - timers (optional):      { setTimeout, clearTimeout } for the path picker's debounce.
//   - refreshProjects():      reloads the sidebar project list after an adopt.
//   - closeSidebarOverflow(): dismisses the sidebar ≡ menu.

// THE ONLY TWO REFUSALS THE DIALOG REWORDS. Every other `adoptProject` reason
// is already a sentence written for a human that names the next action, so the
// general rule is pass-through and a bare code is never shown.
//
// These two name a remedy written for an API CALLER: one tells the user to
// pick a different project name (which cannot help — a transcript directory is
// keyed on the cwd alone, and the project name never enters it), the other
// tells them to pass a JSON field. Each is keyed on a literal TAIL of the
// server's sentence: match ⇒ the remedy clause is REPLACED; no match ⇒ the
// reason renders verbatim, so a changed server sentence degrades to the
// server's own wording rather than to a mangled one.
//
// REPLACED, NEVER STACKED — two contradictory remedies are worse than either
// alone.
//
// The tails are byte-exact copies of sentences the server builds by `+`
// concatenation across source lines (`transcriptCollisionReason` in
// src/systems/transcriptKey.ts, and `adoptProject`'s PROJECT_PLACEMENT_IN_USE
// branch in src/projects.ts). Because the no-match branch is silent, the
// coupling is pinned by a test that builds both refusals from the real
// functions — see tests/adopt-project-dialog.test.mjs.
//
// The TRANSCRIPT_DIR_COLLISION row is removable in one edit once the server
// stops hardcoding a name-picking remedy into a sentence three creation paths
// share; that is carded separately and is not folded in here, because the
// sentence is shared with `createProject`, where "pick another name" is right.
export const REFUSAL_OVERRIDES = [
  {
    code: 'TRANSCRIPT_DIR_COLLISION',
    serverTail: ' Pick another name.',
    remedy: ' Pick a different directory, or delete the record that holds that transcript key.',
  },
  {
    code: 'PROJECT_PLACEMENT_IN_USE',
    serverTail: " — delete them first, or pass onStaleRecord:'replace' to discard them along with the rest of its stored state.",
    remedy: ' — delete them first, or choose Replace below.',
  },
];

// The sentence to show for a soft refusal. Exported for the coupling test.
export function messageFor(result) {
  const reason = typeof result?.reason === 'string' ? result.reason : '';
  if (!reason) return 'the server refused the adoption without giving a reason.';
  const override = REFUSAL_OVERRIDES.find(o => o.code === result?.code);
  if (override && reason.endsWith(override.serverTail)) {
    return reason.slice(0, -override.serverTail.length) + override.remedy;
  }
  return reason;
}

import { loadCapabilities } from './capabilities.js';
import { installPathPicker } from './pathPicker.js';

export function installAdoptProjectDialog({ dom, refreshProjects, closeSidebarOverflow, timers }) {
  // The {name, path, system, remoteId} the open dialog is about. Module-local
  // rather than captured per listener because it has to survive the stale
  // round-trip: the relocate/replace buttons re-send the target the user
  // already chose, and the form is hidden by then.
  let pending = null;

  // The note the local scan produced. Kept here, not read back out of the DOM,
  // because choosing a system overwrites the hint and coming back must restore
  // it without re-scanning.
  let lastLocalNote = '';

  const chosenSystem = () => {
    const v = dom.apdSystem.value;
    return v && v !== 'local' ? v : null;
  };

  // ── The Remote field: a dropdown when the System enumerates ────────
  //
  // A system whose provider lists the remotes it is configured for
  // (`GET /api/systems/:id/remotes` answering `listed`) offers them as a
  // dropdown: an unsubmittable placeholder, the ids, and Other…, which reveals
  // the free-text field for one it did not list. A system that is not
  // enumerable keeps the free-text field; a FAILED enumeration keeps it too and
  // says why, so it is never read as "no remotes". `local` is never asked.
  //
  // The Other… sentinel carries a space, which no remoteId may hold (the server's
  // remoteId rule), so it can never collide with a listed id.
  const REMOTE_OTHER = ' other';
  // 'free': the text field is the Remote. 'select': the dropdown is.
  let remoteMode = 'free';
  // Bumped by every ask and every reset; an answer lands only if its ask is
  // still the latest one.
  let remoteSeq = 0;

  function showRemoteFree(note) {
    remoteMode = 'free';
    dom.apdRemoteSelect.hidden = true;
    dom.apdRemoteSelect.innerHTML = '';
    dom.apdRemote.hidden = false;
    dom.apdRemoteNote.textContent = note;
  }

  // On open and on choosing this machine: no remote, no dropdown, and any ask
  // still in flight is dropped when it lands.
  function resetRemote() {
    ++remoteSeq;
    dom.apdRemote.value = '';
    showRemoteFree('');
  }

  function showRemoteList(system, remoteIds) {
    const select = dom.apdRemoteSelect;
    select.innerHTML = '';
    const add = (value, text) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    };
    add('', '— choose a remote —');
    for (const id of remoteIds) add(id, id);
    add(REMOTE_OTHER, 'Other…');
    remoteMode = 'select';
    select.hidden = false;
    // A remote already typed stays the answer, under Other… — so the switch
    // never changes what chosenRemote() reads.
    const typed = dom.apdRemote.value.trim() !== '';
    select.value = typed ? REMOTE_OTHER : '';
    dom.apdRemote.hidden = !typed;
    dom.apdRemoteNote.textContent = remoteIds.length ? ''
      : `System '${system}' lists no configured remotes right now — choose Other… to type one.`;
  }

  async function loadRemotes(system) {
    const mine = ++remoteSeq;
    showRemoteFree(`Listing the remotes system '${system}' is configured for…`);
    let answer;
    try {
      const res = await fetch(`/api/systems/${encodeURIComponent(system)}/remotes`);
      answer = res.ok ? await res.json() : { state: 'failed', reason: `HTTP ${res.status}` };
    } catch (e) {
      answer = { state: 'failed', reason: e.message };
    }
    if (mine !== remoteSeq || chosenSystem() !== system) return;
    if (answer.state === 'listed') showRemoteList(system, answer.remoteIds);
    else if (answer.state === 'failed') {
      showRemoteFree(`Could not list the remotes of system '${system}' (${answer.reason}) — type one.`);
    } else showRemoteFree('');
  }

  // Blank IS an answer — the provider's own default target — so it reads as
  // null rather than as an empty target name. So does the placeholder, which
  // the adopt refuses before it gets this far.
  const chosenRemote = () => {
    const select = dom.apdRemoteSelect;
    if (remoteMode === 'select' && select.value !== REMOTE_OTHER) return select.value || null;
    return dom.apdRemote.value.trim() || null;
  };

  // With a dropdown up, a remote has to be chosen: the placeholder is not an
  // answer, and neither is Other… left blank.
  const remoteError = (system) => {
    if (!system || remoteMode !== 'select') return null;
    const select = dom.apdRemoteSelect;
    if (select.value === '') return `choose a remote on '${system}' — it lists the remotes it is configured for`;
    if (select.value === REMOTE_OTHER && !dom.apdRemote.value.trim()) {
      return `type a remote for '${system}', or pick a listed one`;
    }
    return null;
  };

  // The same vocabulary the server uses in its own refusals, so the hint and
  // the error that may follow it name one thing.
  const describePlacement = (system, remote) =>
    remote ? `remote '${remote}' of system '${system}'` : `system '${system}'`;

  // Directory completion for the path field, for whichever placement is chosen.
  // The path, system and remote changing all invalidate what it has cached.
  const pathPicker = installPathPicker({
    input: dom.apdPath,
    list: dom.apdPathCompletions,
    note: dom.apdPathNote,
    getPlacement: () => ({ system: chosenSystem(), remoteId: chosenRemote() }),
    timers,
  });

  async function buildSystems() {
    dom.apdSystem.innerHTML = '';
    // A platform without remote Systems offers only this machine: no picker,
    // no note, no remote row, no registry fetch. (Unknown flags, after a failed
    // load, leave the picker as it is; the next open retries.)
    const caps = await loadCapabilities();
    if (caps && !caps.remoteSystems) {
      const row = dom.apdSystem.closest('label');
      if (row) row.hidden = true;
      dom.apdSystemNote.hidden = true;
      syncPlacement();
      return;
    }
    let systems = [{ id: 'local', label: 'This machine', managed: true }];
    let note = '';
    try {
      const r = await fetch('/api/settings/systems');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      systems = (await r.json()).systems ?? systems;
    } catch (e) {
      // NOT SILENT: a local-only picker that cc never managed to fill looks
      // exactly like one with nothing registered, and the user would read a
      // missing system as one they never added.
      note = `Could not read the systems registry (${e.message}) — only this machine is offered.`;
    }
    for (const sys of systems) {
      // A row with no provider command cannot be reached, so a project put on
      // it could never be opened. `local` is in-process and carries none.
      if (!sys.managed && !(Array.isArray(sys.launch) && sys.launch.length)) continue;
      const opt = document.createElement('option');
      opt.value = sys.id;
      opt.textContent = sys.managed ? sys.label : `${sys.label} (${sys.id})`;
      dom.apdSystem.appendChild(opt);
    }
    dom.apdSystem.value = 'local';
    dom.apdSystemNote.textContent = note;
    syncPlacement();
  }

  // The one function that owns which placement the form is about. A list of
  // directories on CC'S OWN DISK, offered while the path field means a path on
  // another machine, would name directories that do not exist there.
  function syncPlacement() {
    const system = chosenSystem();
    dom.apdRemoteRow.hidden = !system;
    dom.apdSuggestions.hidden = !!system;
    dom.apdScanNote.textContent = system
      ? `Type an absolute path on ${describePlacement(system, chosenRemote())}.`
      : lastLocalNote;
  }

  // The server refuses a relative path too (INVALID_TARGET_PATH); checking here
  // is what keeps the dialog open on the field the user has to fix. The remote
  // check is the dialog's own: a dropdown left on its placeholder would
  // otherwise post the provider's default target, which nobody chose. Both
  // gated on a chosen system so a LOCAL adopt surfaces exactly the refusals it
  // did before.
  const placementError = t =>
    t.system && !t.path.startsWith('/') ? `the path on '${t.system}' must be absolute` : remoteError(t.system);

  function showForm() {
    dom.apdForm.hidden = false;
    dom.apdStale.hidden = true;
  }

  function showStale() {
    dom.apdForm.hidden = true;
    dom.apdStale.hidden = false;
  }

  // textContent everywhere, never innerHTML: these paths come off the user's
  // own disk.
  function renderSuggestions(scan) {
    dom.apdSuggestions.innerHTML = '';
    for (const c of scan.candidates ?? []) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button'; // inside <form method="dialog">, a default button submits
      btn.className = 'apd-suggestion';
      const label = document.createElement('span');
      label.className = 'apd-suggestion-path';
      label.textContent = c.relPath;
      btn.appendChild(label);
      if (c.isGitRepo) {
        const badge = document.createElement('span');
        badge.className = 'apd-suggestion-badge';
        badge.textContent = 'git';
        btn.appendChild(badge);
      }
      btn.addEventListener('click', () => {
        dom.apdPath.value = c.path;
        dom.apdName.value = c.suggestedName ?? '';
      });
      li.appendChild(btn);
      dom.apdSuggestions.appendChild(li);
    }
    lastLocalNote = scanNote(scan);
    syncPlacement();
  }

  // A capped or partly-unreadable walk has to SAY SO: otherwise "it is not in
  // the list" reads as "cc looked and it is not adoptable", which a prefix
  // does not entitle the user to conclude.
  function scanNote(scan) {
    const parts = [];
    const n = (scan.candidates ?? []).length;
    parts.push(n === 0
      ? `No unregistered directories found under ${scan.root} — type a path below to adopt one from anywhere.`
      : `${n} unregistered ${n === 1 ? 'directory' : 'directories'} under ${scan.root}, `
        + `${scan.maxDepth} levels deep. Anywhere else: type the path below.`);
    if (scan.truncated) parts.push('The scan was truncated — there may be more.');
    if (scan.unreadable > 0) parts.push(`${scan.unreadable} director${scan.unreadable === 1 ? 'y' : 'ies'} could not be read.`);
    return parts.join(' ');
  }

  async function loadSuggestions() {
    try {
      const res = await fetch('/api/projects/suggestions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderSuggestions(await res.json());
    } catch (e) {
      // A failed scan costs the list, never the dialog — the free-text field
      // is the whole affordance without it.
      dom.apdSuggestions.innerHTML = '';
      lastLocalNote = `Could not scan for directories (${e.message}) — type a path below.`;
      syncPlacement();
    }
  }

  // The three counts a Replace would throw away, named so the user knows what
  // is at stake before authorising the discard.
  function renderDiscards(discards) {
    const d = discards ?? {};
    const rows = [
      [d.attachments ?? 0, 'attachment'],
      [d.debug ?? 0, 'debug capture'],
      [d.worktrees ?? 0, 'worktree registration'],
    ];
    dom.apdStaleDiscards.innerHTML = '';
    for (const [count, noun] of rows) {
      const li = document.createElement('li');
      li.textContent = `${count} ${noun}${count === 1 ? '' : 's'}`;
      dom.apdStaleDiscards.appendChild(li);
    }
  }

  function failForm(message) {
    dom.apdError.textContent = message;
    showForm();
    dom.adoptProjectDialog.showModal();
  }

  async function submit(onStaleRecord) {
    const target = pending;
    if (!target || !target.name || !target.path) return;
    dom.apdError.textContent = '';
    dom.apdStaleError.textContent = '';
    const body = { name: target.name, path: target.path };
    if (target.system) {
      body.system = target.system;
      if (target.remoteId) body.remoteId = target.remoteId;
    }
    if (onStaleRecord) body.onStaleRecord = onStaleRecord;
    let res, data;
    try {
      res = await fetch('/api/projects/external', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await res.json().catch(() => null);
    } catch (e) {
      failForm(e.message);
      return;
    }
    if (!res.ok) { failForm(data?.error ?? `HTTP ${res.status}`); return; }
    if (data?.ok === true) {
      pending = null;
      await refreshProjects();
      return;
    }
    if (data?.code === 'PROJECT_EXISTS_STALE') {
      dom.apdStaleSummary.textContent =
        `Project '${target.name}' is registered at ${data.heldPath}, which no longer exists. `
        + `Relocate repoints that record at ${target.path} and keeps its stored state; `
        + `Replace discards the state below and registers ${target.path} afresh.`;
      renderDiscards(data.discards);
      showStale();
      dom.adoptProjectDialog.showModal();
      return;
    }
    if (data?.code === 'PROJECT_PLACEMENT_IN_USE') {
      // Only ever reached from a Relocate, so the stale pane is already filled
      // — keeping it up leaves Replace, the remedy the refusal names, one
      // click away.
      dom.apdStaleError.textContent = messageFor(data);
      showStale();
      dom.adoptProjectDialog.showModal();
      return;
    }
    failForm(messageFor(data));
  }

  dom.adoptProjectBtn.addEventListener('click', async () => {
    closeSidebarOverflow();
    pending = null;
    dom.apdName.value = '';
    dom.apdPath.value = '';
    resetRemote();
    pathPicker.reset();
    dom.apdSystemNote.textContent = '';
    dom.apdError.textContent = '';
    dom.apdStaleError.textContent = '';
    dom.apdStaleSummary.textContent = '';
    dom.apdStaleDiscards.innerHTML = '';
    showForm();
    // Both end in syncPlacement(), which reads current state — so the order
    // they land in does not matter, and the dialog still opens after one trip.
    await Promise.all([buildSystems(), loadSuggestions()]);
    dom.adoptProjectDialog.showModal();
  });

  // The path field means "a path on the chosen machine", so changing machines
  // invalidates whatever is in it — typed or deposited by the list alike — and
  // any error that named the placement it was about. NOT inside syncPlacement():
  // that also runs on every Remote keystroke, on open, and after a scan, where
  // the path is still about the machine it was entered for.
  dom.apdSystem.addEventListener('change', () => {
    dom.apdPath.value = '';
    dom.apdError.textContent = '';
    pathPicker.reset();
    const system = chosenSystem();
    if (system) loadRemotes(system);
    else resetRemote();
    syncPlacement();
  });
  dom.apdRemote.addEventListener('input', () => {
    pathPicker.reset();
    syncPlacement();
  });
  dom.apdRemoteSelect.addEventListener('change', () => {
    const other = dom.apdRemoteSelect.value === REMOTE_OTHER;
    dom.apdRemote.hidden = !other;
    if (other) dom.apdRemote.focus();
    pathPicker.reset();
    syncPlacement();
  });

  dom.adoptProjectDialog.addEventListener('close', async () => {
    const action = dom.adoptProjectDialog.returnValue;
    if (action === 'adopt') {
      pending = {
        name: dom.apdName.value.trim(),
        path: dom.apdPath.value.trim(),
        system: chosenSystem(),
        remoteId: chosenRemote(),
      };
      const bad = placementError(pending);
      if (bad) { failForm(bad); return; }
      await submit(null);
      return;
    }
    if (action === 'relocate' || action === 'replace') {
      await submit(action);
      return;
    }
    pending = null; // cancel, Esc, or anything else
  });
}
