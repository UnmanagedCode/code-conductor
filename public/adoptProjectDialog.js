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
// rather than sent empty.
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
//            apdSystem, apdSystemNote, apdRemote, apdRemoteRow, apdPath,
//            apdSuggestions, apdScanNote, apdError, apdStaleSummary,
//            apdStaleDiscards, apdStaleError } els.
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

export function installAdoptProjectDialog({ dom, refreshProjects, closeSidebarOverflow }) {
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

  // Blank IS an answer — the provider's own default target — so it reads as
  // null rather than as an empty target name.
  const chosenRemote = () => dom.apdRemote.value.trim() || null;

  // The same vocabulary the server uses in its own refusals, so the hint and
  // the error that may follow it name one thing.
  const describePlacement = (system, remote) =>
    remote ? `remote '${remote}' of system '${system}'` : `system '${system}'`;

  async function buildSystems() {
    dom.apdSystem.innerHTML = '';
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
      ? `Type an absolute path on ${describePlacement(system, chosenRemote())} — cc cannot list directories there.`
      : lastLocalNote;
  }

  // The server refuses this too (INVALID_TARGET_PATH); checking here is what
  // keeps the dialog open on the field the user has to fix. Gated on a chosen
  // system so a LOCAL adopt surfaces exactly the refusals it did before.
  const placementError = t =>
    t.system && !t.path.startsWith('/') ? `the path on '${t.system}' must be absolute` : null;

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
    dom.apdRemote.value = '';
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

  dom.apdSystem.addEventListener('change', syncPlacement);
  dom.apdRemote.addEventListener('input', syncPlacement);

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
