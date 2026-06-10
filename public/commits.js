// Commit history view — a scrollable list of a project's commits (current
// branch / HEAD). Mirrors the review.js module pattern: installCommits()
// returns { open(project), close() }. Tapping a commit row delegates to
// onOpenCommit(project, commit), which opens the shared diff renderer
// (review.js) on top, showing just that commit's change.

let _project = null;
let _onClose = null;

function getEl(id) { return document.getElementById(id); }

function show() {
  getEl('commits-view').hidden = false;
  getEl('main').classList.add('commits-open');
}

function hide() {
  getEl('commits-view').hidden = true;
  getEl('main').classList.remove('commits-open');
}

function close() {
  hide();
  _project = null;
  _onClose?.();
}

function open(project) {
  _project = project;
  location.hash = '#commits';
  show();
  loadCommits();
}

// Synthetic "working tree" row for uncommitted changes. Visually distinct
// from real commits: amber accent, no SHA, no date.
function renderUncommittedRow(project, onOpenCommit) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'commit-row uncommitted';

  const label = document.createElement('span');
  label.className = 'uncommitted-label';
  label.textContent = '~';

  const subject = document.createElement('span');
  subject.className = 'commit-subject';
  subject.textContent = 'Working tree (uncommitted)';

  row.append(label, subject);
  row.addEventListener('click', () => {
    const synthCommit = {
      sha: null,
      shortSha: null,
      subject: 'Working tree (uncommitted)',
      diffUrl: `/api/projects/${encodeURIComponent(project)}/commits/uncommitted/diff`,
    };
    onOpenCommit?.(project, synthCommit);
  });
  return row;
}

function renderRow(project, commit, onOpenCommit, { ahead = false } = {}) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = ahead ? 'commit-row ahead' : 'commit-row';

  const sha = document.createElement('span');
  sha.className = 'commit-sha';
  sha.textContent = commit.shortSha;

  const subject = document.createElement('span');
  subject.className = 'commit-subject';
  subject.title = commit.subject;
  subject.textContent = commit.subject;

  const meta = document.createElement('span');
  meta.className = 'commit-meta';
  meta.textContent = `${commit.author} · ${commit.relativeDate}`;

  row.append(sha, subject, meta);
  row.addEventListener('click', () => onOpenCommit?.(project, commit));
  return row;
}

async function loadCommits() {
  const project = _project;
  if (!project) return;

  const listEl = getEl('commits-list');
  const titleEl = getEl('commits-title');
  const statsEl = getEl('commits-stats');

  titleEl.textContent = project;
  statsEl.textContent = '';
  listEl.innerHTML = '';
  listEl.appendChild(Object.assign(document.createElement('div'), {
    className: 'review-loading', textContent: 'Loading commits…',
  }));

  let data;
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(project)}/commits`,
      { cache: 'no-store' },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    data = await res.json();
  } catch (e) {
    listEl.innerHTML = '';
    listEl.appendChild(Object.assign(document.createElement('div'), {
      className: 'review-error', textContent: `Failed to load commits: ${e.message}`,
    }));
    return;
  }

  if (data.branch) titleEl.textContent = `${project} · ${data.branch}`;

  listEl.innerHTML = '';
  if (!data.commits || data.commits.length === 0) {
    if (data.hasUncommitted) {
      listEl.appendChild(renderUncommittedRow(project, api.onOpenCommit));
    }
    listEl.appendChild(Object.assign(document.createElement('div'), {
      className: 'review-empty', textContent: 'No commits',
    }));
    return;
  }

  // Stats line: commit count + ahead summary when applicable.
  const parts = [`${data.commits.length} commit${data.commits.length === 1 ? '' : 's'}`];
  if (data.truncated) parts.push(`(showing latest ${data.limit})`);
  if (data.aheadCount > 0 && data.aheadOf) {
    parts.push(`· ${data.aheadCount} ahead of ${data.aheadOf}`);
  }
  statsEl.textContent = parts.join(' ');

  // Uncommitted changes synthetic entry at the very top.
  if (data.hasUncommitted) {
    listEl.appendChild(renderUncommittedRow(project, api.onOpenCommit));
  }

  // How many of the shown commits are "ahead" of the base.
  const effectiveAheadCount = Math.min(data.aheadCount ?? 0, data.commits.length);

  for (let i = 0; i < data.commits.length; i++) {
    // Divider between ahead commits and already-merged commits.
    if (effectiveAheadCount > 0 && i === effectiveAheadCount) {
      const divider = document.createElement('div');
      divider.className = 'ahead-divider';
      divider.textContent = `in ${data.aheadOf}`;
      listEl.appendChild(divider);
    }
    listEl.appendChild(renderRow(project, data.commits[i], api.onOpenCommit, {
      ahead: i < effectiveAheadCount,
    }));
  }
}

// Public handle. onOpenCommit is assigned by the caller after install.
const api = { open, close, onOpenCommit: null };

export function installCommits({ onClose } = {}) {
  _onClose = onClose;

  getEl('commits-back')?.addEventListener('click', () => close());

  // Capture phase: runs before review.js's bubble-phase handler, so when the
  // diff is layered on top (review-view visible) we bail and let review handle
  // Escape; otherwise we close the commit list.
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !getEl('commits-view')?.hidden && getEl('review-view')?.hidden) {
      close();
    }
  }, true);

  window.addEventListener('hashchange', () => {
    // Stay open while the diff view (#review) is layered on top; only tear
    // down when navigating somewhere unrelated.
    const h = location.hash;
    if (h !== '#commits' && h !== '#review' && !getEl('commits-view')?.hidden) {
      close();
    }
  });

  return api;
}
