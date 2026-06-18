// Review view — renders a structured unified diff (per-file, collapsible).
// Activated via location.hash = '#review'; mirrors the settings.js pattern:
// installReview() returns { open({ title, url, onBack }), close() }.
// The same renderer serves both worktree diffs and per-commit diffs — only the
// title and the fetch URL differ, supplied by the caller via open().

import { diffLine } from './blocks.js';

let _title = '';
let _url = null;
let _onBack = null;

function getEl(id) { return document.getElementById(id); }

function show() {
  getEl('review-view').hidden = false;
  getEl('main').classList.add('review-open');
}

function hide() {
  getEl('review-view').hidden = true;
  getEl('main').classList.remove('review-open');
}

function goBack() {
  hide();
  const cb = _onBack;
  _title = '';
  _url = null;
  _onBack = null;
  cb?.();
}

function close() {
  goBack();
}

function open({ title, url, onBack } = {}) {
  _title = title || '';
  _url = url || null;
  _onBack = onBack || null;
  location.hash = '#review';
  show();
  loadDiff();
}

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
  if (data.truncated) parts.push('(truncated)');
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

function renderFile(file) {
  const details = document.createElement('details');
  details.className = 'review-file';

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

  if (file.hunks && file.hunks.length > 0) {
    const body = document.createElement('div');
    body.className = 'review-diff-body';
    for (const hunk of file.hunks) {
      const hdrEl = document.createElement('div');
      hdrEl.className = 'review-hunk-header';
      hdrEl.textContent = hunk.header;
      body.appendChild(hdrEl);

      for (const ln of hunk.lines) {
        const type = ln.type === 'add' ? 'add' : ln.type === 'del' ? 'del' : 'ctx';
        body.appendChild(diffLine(type, ln.content));
      }
    }
    details.appendChild(body);
  }

  return details;
}

export function installReview() {
  getEl('review-back')?.addEventListener('click', () => history.back());

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !getEl('review-view')?.hidden) history.back();
  });

  window.addEventListener('hashchange', () => {
    if (location.hash !== '#review' && !getEl('review-view')?.hidden) {
      // Hash navigated away (hardware/browser back or commits-back) — run the
      // full goBack() so the onBack callback (e.g. closeReview) still fires.
      goBack();
    }
  });

  return { open, close };
}
