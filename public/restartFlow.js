// Client restart flow: the restart-server button, its resume/plain confirm
// dialog, the POST → wait-for-server-back → reload sequence, and the background
// reconnect-status display. Owns restartInProgress/everConnected/everDropped.
//
// Self-respawn happens server-side: POST kicks the orchestrator which spawns a
// detached replacement and exits. Once the NEW server is responding we trigger
// a full `location.reload()` so frontend assets (HTML/CSS/JS) get re-fetched
// too — otherwise the open tab keeps its pre-restart code in memory.
//
// Boot-id handshake: on the resume path the old server stays up for the whole
// ≤60 s drain, so a plain "is it up?" poll would reload against the dying old
// process. We capture GET /api/health's per-process bootId BEFORE the POST, then
// poll until we see a DIFFERENT bootId (the replacement). Falls back to plain
// "any ok" if the pre-POST capture failed, so we never hang.
//
// Follows the installX({...}) pattern. Injected interface:
//   - dom:               { restartBtn, restartDialog, restartBlurb } els.
//   - bus:               the shared WS EventTarget from ws.js.
//   - getInstances():    returns state.instances (read live each call).
//   - setSidebarStatus:  stays in app.js (also drives the anchor/auto-resume
//                        path) and is injected here.
export function installRestart({ dom, bus, getInstances, setSidebarStatus }) {
  let restartInProgress = false;
  // Fetch this process's boot id, or null if the probe fails. cache:'no-store'
  // so the SW/HTTP cache can't serve a stale id from before the restart.
  async function getBootId() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      return j?.bootId ?? null;
    } catch { return null; }
  }
  // Poll /api/health until the REPLACEMENT process answers — i.e. ok with a
  // bootId different from the one captured before the restart. If we never
  // captured a prior id (priorBootId null), accept any ok so we don't hang.
  async function waitForReplacement(priorBootId, { tries = 60, delayMs = 250 } = {}) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          const bootId = j?.bootId ?? null;
          if (priorBootId == null || (bootId && bootId !== priorBootId)) return true;
        }
      } catch { /* server still down */ }
      await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
  }
  // Run the restart → wait-for-server-back → reload flow. `resume` picks the
  // graceful drain path (carries sessions over); the resume branch widens the
  // poll budget to outlast the server-side drain (≤60 s) since HTTP is torn down
  // only after all sessions reach idle.
  async function performRestart({ resume = false } = {}) {
    if (restartInProgress) return;
    restartInProgress = true;
    dom.restartBtn.disabled = true;
    setSidebarStatus(resume ? 'draining sessions…' : 'restarting…', { warn: true });
    // Capture the CURRENT process's boot id before restarting so we can tell the
    // replacement apart from the old server (which stays up through a resume
    // drain). Must run before the POST — after it the old server is on its way out.
    const priorBootId = await getBootId();
    // Fire the restart. The server replies 202 then exits; the fetch may either
    // resolve or be aborted mid-flight — both are fine.
    await fetch('/api/admin/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume }),
    }).catch(() => {});
    setSidebarStatus('waiting for server…', { warn: true });
    // Poll for a DIFFERENT bootId (the replacement process). 480 × 250 ms = 120 s
    // — comfortably outlasts the ≤60 s resume drain plus teardown + boot before
    // the new server answers.
    await waitForReplacement(priorBootId, resume ? { tries: 480, delayMs: 250 } : undefined);
    setSidebarStatus('reloading…', { warn: true });
    // Full reload so the new HTML/CSS/JS replace what's in memory.
    location.reload();
  }
  dom.restartBtn.addEventListener('click', async () => {
    if (restartInProgress) return;
    // No live sessions → nothing to resume; keep the immediate hard restart.
    if (!getInstances().length) { await performRestart({ resume: false }); return; }
    const n = getInstances().length;
    if (dom.restartBlurb) {
      dom.restartBlurb.textContent =
        `${n} active session${n === 1 ? '' : 's'}. Resume them after the restart, or restart only (sessions are dropped — temp sessions are archived)?`;
    }
    dom.restartDialog.showModal();
  });
  dom.restartDialog?.addEventListener('close', async () => {
    const choice = dom.restartDialog.returnValue;
    if (choice === 'resume') await performRestart({ resume: true });
    else if (choice === 'plain') await performRestart({ resume: false });
    // 'cancel' / dismiss → no-op.
  });
  dom.restartDialog?.addEventListener('click', (e) => {
    if (e.target === dom.restartDialog) dom.restartDialog.close();
  });
  // Background connection status (unrelated to manual restart): show
  // "reconnecting…" if the WS drops on its own, clear it on reconnect.
  let everConnected = false;
  let everDropped = false;
  bus.addEventListener('open', () => {
    everConnected = true;
    if (everDropped && !restartInProgress) {
      setSidebarStatus('');
      everDropped = false;
    }
  });
  bus.addEventListener('close', () => {
    if (!everConnected || restartInProgress) return;
    everDropped = true;
    setSidebarStatus('reconnecting…', { warn: true });
  });
  bus.addEventListener('reconnecting', () => {
    if (!everConnected || restartInProgress) return;
    setSidebarStatus('reconnecting…', { warn: true });
  });
}
