// Review view — browse per-file diffs for a worktree before merging.
// Activated via location.hash = '#review'; mirrors the settings.js pattern:
// installReview() returns { open(project, wt), close() }.

let _project = null;
let _worktreeName = null;
let _onClose = null;

function getEl(id) { return document.getElementById(id); }

function show() {
  getEl('review-view').hidden = false;
  getEl('main').classList.add('review-open');
}

function hide() {
  getEl('review-view').hidden = true;
  getEl('main').classList.remove('review-open');
}

function close() {
  hide();
  _project = null;
  _worktreeName = null;
  _onClose?.();
}

function open(project, worktreeName) {
  _project = project;
  _worktreeName = worktreeName;
  location.hash = '#review';
  show();
  loadDiff();
}

async function loadDiff() {
  const project = _project;
  const wt = _worktreeName;
  if (!project || !wt) return;

  const fileList = getEl('review-file-list');
  const titleEl = getEl('review-title');
  const statsEl = getEl('review-stats');

  const shortName = wt.replace(`${project}_worktree_`, '');
  titleEl.textContent = `${project} / ${shortName}`;
  statsEl.textContent = '';
  fileList.innerHTML = '';
  fileList.appendChild(Object.assign(document.createElement('div'), {
    className: 'review-loading', textContent: 'Loading diff…',
  }));

  let data;
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(project)}/worktrees/${encodeURIComponent(wt)}/diff`,
      { cache: 'no-store' },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    data = await res.json();
  } catch (e) {
    fileList.innerHTML = '';
    fileList.appendChild(Object.assign(document.createElement('div'), {
      className: 'review-error', textContent: `Failed to load diff: ${e.message}`,
    }));
    return;
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
        const lineEl = document.createElement('div');
        lineEl.className = `diff-line ${ln.type === 'add' ? 'add' : ln.type === 'del' ? 'del' : 'ctx'}`;

        const marker = document.createElement('span');
        marker.className = 'diff-marker';
        marker.textContent = ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' ';

        const text = document.createElement('span');
        text.className = 'diff-text';
        text.textContent = ln.content;

        lineEl.append(marker, text);
        body.appendChild(lineEl);
      }
    }
    details.appendChild(body);
  }

  return details;
}

export function installReview({ onClose } = {}) {
  _onClose = onClose;

  getEl('review-back')?.addEventListener('click', () => {
    hide();
    _project = null;
    _worktreeName = null;
    onClose?.();
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !getEl('review-view')?.hidden) {
      hide();
      _project = null;
      _worktreeName = null;
      onClose?.();
    }
  });

  window.addEventListener('hashchange', () => {
    if (location.hash !== '#review' && !getEl('review-view')?.hidden) {
      hide();
      _project = null;
      _worktreeName = null;
    }
  });

  return { open, close };
}
