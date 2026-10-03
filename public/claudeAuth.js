// Settings → Account → Claude login: the orchestrator CLI's sign-in state and
// the browser-driven `claude auth login` flow (src/claudeLogin.ts).
//
// The flow lives on the server, so any tab sees it: load() resumes an in-flight
// one. While it is active the snapshot is polled every `pollMs`; a terminal
// state stops the poll. The sign-in URL is shown both as a link and as a
// read-only field to copy to another device — the Clipboard API is unavailable
// over plain-http remote access.
//
// `onLoginSuccess` fires once when a flow this tab is watching reaches
// `succeeded` — the account may have changed, so account-wide displays refresh.
//
// Element ids: ca-status, ca-login, ca-flow, ca-await, ca-url, ca-url-text,
// ca-code, ca-submit, ca-cancel, ca-flow-msg.

import { apiFetch } from './http.js';

const BASE = '/api/claude-auth';
const ACTIVE = new Set(['starting', 'awaiting_code', 'verifying']);
const POST = { method: 'POST', headers: { 'content-type': 'application/json' } };

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function installClaudeAuth({ pollMs = 1000, onLoginSuccess } = {}) {
  const $ = (id) => document.getElementById(id);
  const statusEl = $('ca-status');
  const loginBtn = $('ca-login');
  const flowEl = $('ca-flow');
  const awaitEl = $('ca-await');
  const urlEl = $('ca-url');
  const urlTextEl = $('ca-url-text');
  const codeEl = $('ca-code');
  const submitBtn = $('ca-submit');
  const cancelBtn = $('ca-cancel');
  const msgEl = $('ca-flow-msg');
  if (!statusEl) return { load() {} };

  let pollTimer = null;
  let flowActive = false;
  // Bumped by every action (start, submit, cancel, load) and every terminal
  // render. A login-flow response is rendered only if no bump happened since
  // its request went out, so a slow poll can never repaint a flow the user has
  // since cancelled or seen end.
  let gen = 0;
  // A refused start's message, kept under the flow it surfaced until the user
  // acts or that flow ends.
  let notice = '';

  function line(text, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    return div;
  }

  function renderStatus(s) {
    statusEl.replaceChildren();
    const head = document.createElement('strong');
    const details = [];
    if (s.loggedIn && s.authMethod === 'claude.ai') {
      head.textContent = 'Signed in';
      details.push(s.email, s.orgName, s.subscriptionType && `${capitalise(s.subscriptionType)} plan`, 'Claude subscription');
    } else if (s.loggedIn && s.authMethod === 'api_key') {
      head.textContent = 'Using an API key';
      if (s.apiKeySource) details.push(s.apiKeySource);
    } else if (s.loggedIn) {
      head.textContent = 'Signed in';
      details.push(s.authMethod);
    } else {
      head.textContent = 'Not signed in';
    }
    statusEl.append(head);
    const shown = details.filter(Boolean);
    if (shown.length) statusEl.append(' · ' + shown.join(' · '));
    if (s.loggedIn && s.authMethod === 'api_key') {
      statusEl.append(line("cc's environment sets this key and sessions use it; a login here won't change that.", 'settings-hint'));
    }
    if (s.configDirectory) statusEl.append(line(`Credentials: ${s.configDirectory}`, 'settings-hint'));
    if (loginBtn) loginBtn.textContent = s.loggedIn ? 'Re-log in' : 'Log in';
  }

  async function loadStatus() {
    try {
      renderStatus(await apiFetch(`${BASE}/status`, { cache: 'no-store' }));
    } catch (e) {
      // Never "Not signed in": an unreadable state is not a signed-out one.
      statusEl.textContent = `Could not read the Claude login state: ${e.message || e}`;
    }
  }

  function setMsg(text) { if (msgEl) msgEl.textContent = text; }

  function renderFlow(snap, { initial = false } = {}) {
    const active = ACTIVE.has(snap.state);
    const wasActive = flowActive;
    flowActive = active;
    if (loginBtn) loginBtn.disabled = active;
    if (!flowEl) return;
    // On load a finished flow from earlier is not news: show only a live one.
    flowEl.hidden = snap.state === 'idle' || (initial && !active);
    if (cancelBtn) cancelBtn.hidden = !active;
    const awaiting = snap.state === 'awaiting_code' || snap.state === 'verifying';
    if (awaitEl) awaitEl.hidden = !awaiting;
    if (awaiting && snap.url) {
      if (urlEl) urlEl.href = snap.url;
      if (urlTextEl) urlTextEl.value = snap.url;
    }
    if (codeEl) codeEl.disabled = snap.state !== 'awaiting_code';
    if (submitBtn) submitBtn.disabled = snap.state !== 'awaiting_code';
    switch (snap.state) {
      case 'starting': setMsg(notice || 'Starting…'); break;
      case 'awaiting_code': setMsg(snap.error || notice); break;
      case 'verifying': setMsg('Verifying…'); break;
      case 'succeeded': setMsg('Signed in.'); break;
      case 'failed': setMsg(snap.error || 'Login failed.'); break;
      case 'cancelled': setMsg('Login cancelled.'); break;
      default: setMsg('');
    }
    if (active) schedulePoll();
    else { gen++; notice = ''; stopPoll(); }
    if (wasActive && snap.state === 'succeeded') {
      loadStatus();
      onLoginSuccess?.();
    }
  }

  function stopPoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  function schedulePoll() {
    stopPoll();
    pollTimer = setTimeout(poll, pollMs);
  }
  async function poll() {
    pollTimer = null;
    const g = gen;
    try {
      const snap = await apiFetch(`${BASE}/login`, { cache: 'no-store' });
      if (g === gen) renderFlow(snap);
    } catch (e) {
      if (g !== gen) return;
      setMsg(`Could not read the login progress: ${e.message || e}`);
      schedulePoll();
    }
  }

  // Resolves to the error message on a refusal, else null.
  async function act(url, body) {
    notice = '';
    stopPoll();
    const g = ++gen;
    try {
      const snap = await apiFetch(url, { ...POST, body: JSON.stringify(body ?? {}) });
      if (g === gen) renderFlow(snap);
      return null;
    } catch (e) {
      const msg = e.message || String(e);
      if (g === gen) setMsg(msg);
      return msg;
    }
  }

  loginBtn?.addEventListener('click', async () => {
    if (codeEl) codeEl.value = '';
    if (flowEl) flowEl.hidden = false;
    const refused = await act(`${BASE}/login`);
    if (!refused) return;
    // Refused — usually a flow another tab started. Surface whatever is running
    // (so it can be cancelled), keeping the refusal on screen.
    notice = refused;
    await load();
    if (flowEl) flowEl.hidden = false;
    setMsg(refused);
  });
  function submit() {
    if (!codeEl || codeEl.disabled) return;
    act(`${BASE}/login/code`, { code: codeEl.value.trim() });
  }
  submitBtn?.addEventListener('click', submit);
  codeEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  cancelBtn?.addEventListener('click', () => act(`${BASE}/login/cancel`));

  async function load() {
    stopPoll();
    const g = ++gen;
    const [, snap] = await Promise.all([
      loadStatus(),
      apiFetch(`${BASE}/login`, { cache: 'no-store' }).catch(() => null),
    ]);
    if (snap && g === gen) renderFlow(snap, { initial: true });
  }

  return { load };
}
