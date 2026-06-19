// Client restart flow: the restart-server button, its resume/plain confirm
// dialog, the POST → wait-for-server-back → reload sequence, and the background
// reconnect-status display. Owns restartInProgress/everConnected/everDropped.
//
// Self-respawn happens server-side: POST kicks the orchestrator which spawns a
// detached replacement and exits. Once the new server is responding to HTTP
// again we trigger a full `location.reload()` so frontend assets (HTML/CSS/JS)
// get re-fetched too — otherwise the open tab keeps its pre-restart code in
// memory.
//
// Follows the installX({...}) pattern. Injected interface:
//   - dom:               { restartBtn, restartDialog, restartBlurb } els.
//   - bus:               the shared WS EventTarget from ws.js.
//   - getInstances():    returns state.instances (read live each call).
//   - setSidebarStatus:  stays in app.js (also drives the anchor/auto-resume
//                        path) and is injected here.
export function installRestart({ dom, bus, getInstances, setSidebarStatus }) {
  let restartInProgress = false;
  async function waitForServerBack({ tries = 60, delayMs = 250 } = {}) {
    // Poll a cheap endpoint until it answers. cache:'no-store' is
    // important — without it the SW or HTTP cache could serve a stale
    // 200 from before the restart and we'd reload too early.
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch('/api/projects', { cache: 'no-store' });
        if (r.ok) return true;
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
    // Fire the restart. The server replies 202 then exits; the fetch may either
    // resolve or be aborted mid-flight — both are fine.
    await fetch('/api/admin/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume }),
    }).catch(() => {});
    // Give the server a moment before we start probing so the first probe
    // doesn't hit the still-alive old server and reload prematurely.
    await new Promise(r => setTimeout(r, 800));
    setSidebarStatus('waiting for server…', { warn: true });
    // 480 × 250 ms = 120 s — comfortably outlasts the ≤60 s drain plus the
    // teardown + replacement-boot window before the new server answers.
    await waitForServerBack(resume ? { tries: 480, delayMs: 250 } : undefined);
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
        `${n} active session${n === 1 ? '' : 's'}. Resume them after the restart, or restart only (sessions are dropped — temp sessions are cleaned up)?`;
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
