// Review view — renders a structured unified diff (per-file, collapsible).
// Activated via location.hash = '#review'; built on the shared installHashView
// scaffold: installReview() returns { open({ title, url, onBack }), close() }.
// The same renderer serves both worktree diffs and per-commit diffs — only the
// title and the fetch URL differ, supplied by the caller via open().
//
// The initial payload is a per-file summary (no hunks) — safe for any change
// size. Hunks for one file are fetched lazily via `?path=<file>` when its
// <details> card is expanded, and cached on the card so re-expanding is free.

import { diffLine } from './blocks.js';
import { installHashView } from './hashView.js';

let _title = '';
let _url = null;
let _onBack = null;
// Bumped on every onShow/onTeardown so an in-flight per-file fetch that
// resolves after the view moved on drops its result instead of painting
// into recycled DOM.
let _seq = 0;

// Per-card fetch state, keyed by the <details> element — a module-level Map
// keyed by path would leak across views/re-opens.
const _cardState = new WeakMap();

function getEl(id) { return document.getElementById(id); }

async function loadDiff() {
  const url = _url;
  if (!url) return;

  const fileList = getEl('review-file-list');
  const titleEl = getEl('review-title');
  const statsEl = getEl('review-stats');

  const msgEl = getEl('review-commit-message');
  titleEl.textContent = _title;
  statsEl.textContent = '';
  if (msgEl) msgEl.hidden = true;
  fileList.innerHTML = '';
  fileList.appendChild(Object.assign(document.createElement('div'), {
    className: 'review-loading', textContent: 'Loading diff…',
  }));

  let data;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    data = await res.json();
  } catch (e) {
    if (msgEl) msgEl.hidden = true;
    fileList.innerHTML = '';
    fileList.appendChild(Object.assign(document.createElement('div'), {
      className: 'review-error', textContent: `Failed to load diff: ${e.message}`,
    }));
    return;
  }

  if (msgEl) {
    if (data.commitMessage) {
      msgEl.textContent = data.commitMessage;
      msgEl.hidden = false;
    } else {
      msgEl.hidden = true;
    }
  }

  const parts = [];
  if (data.totalAdds > 0) parts.push(`+${data.totalAdds}`);
  if (data.totalDels > 0) parts.push(`-${data.totalDels}`);
  if (typeof data.totalFiles === 'number') {
    parts.push(`${data.totalFiles} file${data.totalFiles === 1 ? '' : 's'}`);
  }
  statsEl.textContent = parts.join(' ');

  fileList.innerHTML = '';
  if (!data.files || data.files.length === 0) {
    fileList.appendChild(Object.assign(document.createElement('div'), {
      className: 'review-empty', textContent: 'No changes',
    }));
    return;
  }
  for (const file of data.files) {
    fileList.appendChild(renderFile(file));
  }
}

function fileUrl(file) {
  const u = new URL(_url, location.href);
  u.searchParams.set('path', file.path);
  return u.pathname + u.search;
}

async function loadFileDiff(file, body, details) {
  const state = _cardState.get(details);
  state.inFlight = true;
  body.innerHTML = '';
  body.appendChild(Object.assign(document.createElement('div'), {
    className: 'review-file-loading', textContent: 'Loading diff…',
  }));

  const mine = _seq;
  let json;
  try {
    const res = await fetch(fileUrl(file), { cache: 'no-store' });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    json = await res.json();
  } catch (e) {
    if (mine !== _seq) return;
    state.inFlight = false;
    body.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'review-file-error';
    errEl.append(`Failed to load diff: ${e.message} `);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'review-file-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => loadFileDiff(file, body, details));
    errEl.appendChild(retry);
    body.appendChild(errEl);
    return;
  }
  if (mine !== _seq) return;

  state.inFlight = false;
  state.loaded = true;
  const detail = json.file;
  body.innerHTML = '';

  if (detail.oversized) {
    body.appendChild(Object.assign(document.createElement('div'), {
      className: 'review-file-note',
      textContent: `Diff too large to render inline (+${detail.adds} / −${detail.dels} lines) — view this file locally`,
    }));
    return;
  }

  const inner = document.createElement('div');
  inner.className = 'review-diff-inner';
  for (const hunk of detail.hunks) {
    const hdrEl = document.createElement('div');
    hdrEl.className = 'review-hunk-header';
    hdrEl.textContent = hunk.header;
    inner.appendChild(hdrEl);

    for (const ln of hunk.lines) {
      const type = ln.type === 'add' ? 'add' : ln.type === 'del' ? 'del' : 'ctx';
      inner.appendChild(diffLine(type, ln.content));
    }
  }
  body.appendChild(inner);

  if (detail.truncated) {
    body.appendChild(Object.assign(document.createElement('div'), {
      className: 'review-file-note',
      textContent: `diff cut at 200 KB — showing the first part of ${detail.bytes} bytes`,
    }));
  }
}

function renderFile(file) {
  const details = document.createElement('details');
  details.className = 'review-file';
  _cardState.set(details, { loaded: false, inFlight: false });

  const summary = document.createElement('summary');
  summary.className = 'review-file-head';

  const STATUS_ICON = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' };
  const statusEl = document.createElement('span');
  statusEl.className = `review-file-status review-status-${file.status}`;
  statusEl.textContent = STATUS_ICON[file.status] ?? 'M';

  const pathDisplay = file.status === 'renamed' && file.oldPath
    ? `${file.oldPath} → ${file.path}`
    : file.path;
  const nameEl = document.createElement('span');
  nameEl.className = 'review-file-path';
  nameEl.title = pathDisplay;
  nameEl.textContent = pathDisplay;

  const statsEl = document.createElement('span');
  statsEl.className = 'review-file-stats';
  if (file.adds > 0) {
    const ins = document.createElement('ins');
    ins.textContent = `+${file.adds}`;
    statsEl.appendChild(ins);
  }
  if (file.dels > 0) {
    const del = document.createElement('del');
    del.textContent = `-${file.dels}`;
    statsEl.appendChild(del);
  }

  summary.append(statusEl, nameEl, statsEl);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'review-diff-body';
  // Rows go inside an inner wrapper (not directly in the scroll container)
  // so they can all share the wrapper's shrink-to-fit width — see
  // .review-diff-inner in styles.css for why.
  const inner = document.createElement('div');
  inner.className = 'review-diff-inner';
  body.appendChild(inner);
  details.appendChild(body);

  if (file.binary) {
    inner.appendChild(Object.assign(document.createElement('div'), {
      className: 'review-file-note', textContent: 'Binary file — no text diff',
    }));
    _cardState.get(details).loaded = true;
    return details;
  }

  details.addEventListener('toggle', () => {
    if (!details.open) return;
    const state = _cardState.get(details);
    if (state.loaded || state.inFlight) return;
    loadFileDiff(file, body, details);
  });

  return details;
}

export function installReview() {
  // Bubble-phase Escape (escapeCapture:false) so commits.js's capture-phase
  // handler runs first and can bail while this diff is layered on top.
  return installHashView({
    name: 'review',
    escapeCapture: false,
    navigate: () => { location.hash = '#review'; },
    onShow: ({ title, url, onBack } = {}) => {
      _seq++;
      _title = title || '';
      _url = url || null;
      _onBack = onBack || null;
      loadDiff();
    },
    // Hash navigated away (hardware/browser back or commits-back) — run the
    // full teardown so the onBack callback (e.g. closeReview) still fires.
    onTeardown: () => {
      _seq++;
      const cb = _onBack;
      _title = '';
      _url = null;
      _onBack = null;
      cb?.();
    },
  });
}
