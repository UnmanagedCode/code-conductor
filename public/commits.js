// Commit history view — a scrollable list of a project's commits (current
// branch / HEAD). Mirrors the review.js module pattern: installCommits()
// returns { open(project), close() }. Tapping a commit row delegates to
// onOpenCommit(project, commit), which opens the shared diff renderer
// (review.js) on top, showing just that commit's change.

let _project = null;
let _onClose = null;

function getEl(id) { return document.getElementById(id); }

// ── Branch/merge graph ──────────────────────────────────────────────────────
// A git-log --graph–style multi-lane DAG rail drawn to the LEFT of each commit
// row. computeGraph() assigns each commit a stable column ("lane") and snapshots
// the lanes entering (lanesBefore) and leaving (lanesAfter) the row; the rail is
// drawn per-row (a fixed-height SVG "node band" + full-height CSS filler lines)
// so it aligns with variable-height rows without any post-layout measurement.

const SVG_NS = 'http://www.w3.org/2000/svg';
const LANE_W = 14;        // horizontal spacing between lanes (px)
const DOT_R = 3.5;        // commit dot radius (px)
const BAND_H = 32;        // fixed height of the SVG node band at the top of a row (px)
// Dot vertical centre, in px from the row's top edge. Tuned to sit on the first
// line of `.commit-sha`: .commit-row padding-top 8 + .commit-sha padding-top 1 +
// ~½ of the 12px-monospace line box. If you retune the row/sha padding or font
// in styles.css, adjust this single constant to re-centre the dot.
const DOT_CY = 17;
const MAX_LANES = 12;     // soft cap; extra lanes clamp to the last column (logged)

// Lane palette — bright hues that read well on the dark --panel-1/--panel-2
// backgrounds. Leads with the theme accents (--accent, --tool, --green, --amber,
// --red) then two extra distinct hues.
const LANE_COLORS = [
  '#6ea8ff', // accent blue
  '#7ad5d3', // tool teal
  '#4ade80', // green
  '#f59e0b', // amber
  '#f87171', // red
  '#c084fc', // purple
  '#f472b6', // pink
];
function laneColor(col) { return LANE_COLORS[col % LANE_COLORS.length]; }

// Assign lanes over the commit list (index 0 = newest/tip). Returns
// { rows, maxCols } where rows[i] = { col, color, lanesBefore, lanesAfter } and
// lanesBefore/lanesAfter are arrays indexed by column whose value is the SHA that
// lane routes toward (or null when free). Column indices are stable for the life
// of a lane (freed slots are reused), so pass-through lanes stay vertically
// aligned from row to row. Parents not present in the list (older than the cap /
// unfetched) are simply never matched: their lane stays active and trails off the
// bottom of the last row.
function computeGraph(commits) {
  const activeLanes = []; // column -> sha targeted, or null
  const rows = [];
  let maxCols = 0;
  let clamped = false;

  const firstFreeColumn = () => {
    for (let k = 0; k < activeLanes.length; k++) {
      if (activeLanes[k] == null) return k;
    }
    if (activeLanes.length >= MAX_LANES) { clamped = true; return MAX_LANES - 1; }
    activeLanes.push(null);
    return activeLanes.length - 1;
  };

  for (const commit of commits) {
    const sha = commit.sha;
    const parents = commit.parents || [];
    const lanesBefore = activeLanes.slice();

    // Lanes whose child already pointed at this commit converge here.
    const converging = [];
    for (let k = 0; k < activeLanes.length; k++) {
      if (activeLanes[k] === sha) converging.push(k);
    }
    const col = converging.length ? Math.min(...converging) : firstFreeColumn();

    // Free the extra converging lanes — they merge into `col`.
    for (const k of converging) if (k !== col) activeLanes[k] = null;

    // Route parents out of `col`.
    if (parents.length === 0) {
      activeLanes[col] = null; // root: lane terminates
    } else {
      activeLanes[col] = parents[0]; // first parent continues in the same column
      for (let j = 1; j < parents.length; j++) {
        const pj = parents[j];
        if (activeLanes.indexOf(pj) === -1) activeLanes[firstFreeColumn()] = pj;
        // else: a lane already targets pj — the merge converges into it later.
      }
    }

    const lanesAfter = activeLanes.slice();
    rows.push({ sha, col, color: laneColor(col), lanesBefore, lanesAfter });
    maxCols = Math.max(maxCols, lanesBefore.length, lanesAfter.length, col + 1);
  }

  if (clamped) {
    console.warn(`commits graph: lane count exceeded ${MAX_LANES}; extra lanes clamped to the last column`);
  }
  return { rows, maxCols: Math.min(maxCols, MAX_LANES) };
}

function laneX(col) { return col * LANE_W + LANE_W / 2; }

function svgLine(x1, y1, x2, y2, color) {
  const l = document.createElementNS(SVG_NS, 'line');
  l.setAttribute('x1', x1); l.setAttribute('y1', y1);
  l.setAttribute('x2', x2); l.setAttribute('y2', y2);
  l.setAttribute('stroke', color);
  l.setAttribute('stroke-width', '2');
  l.setAttribute('stroke-linecap', 'round');
  return l;
}

// Build the left rail element for one commit row from its computed layout.
// `node` = true draws the commit dot; uncommitted/spacer rows pass node:false.
function buildRail(layout, maxCols, { node = true, dotClass = '' } = {}) {
  const rail = document.createElement('div');
  rail.className = 'commit-rail';
  const width = Math.max(maxCols, 1) * LANE_W;
  rail.style.width = `${width}px`;

  if (!layout) return rail; // no topology (e.g. spacer)

  const { sha, col, color, lanesBefore, lanesAfter } = layout;
  const cx = laneX(col);

  // Node band: incoming convergence (top→dot) + outgoing forks (dot→bottom) +
  // straight pass-through verticals, all within the fixed BAND_H.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'rail-band');
  svg.setAttribute('width', width);
  svg.setAttribute('height', BAND_H);

  // Incoming lanes (top edge → DOT_CY). A lane whose target is THIS commit bends
  // into `cx` (convergence/merge-point); every other lane passes straight through.
  for (let k = 0; k < lanesBefore.length; k++) {
    const target = lanesBefore[k];
    if (target == null) continue;
    const x = laneX(k);
    if (target === sha) svg.appendChild(svgLine(x, 0, cx, DOT_CY, laneColor(k)));
    else svg.appendChild(svgLine(x, 0, x, DOT_CY, laneColor(k)));
  }

  // Outgoing lanes (DOT_CY → bottom edge of band). The first-parent continuation
  // (k === col) and any newly-forked merge lane (absent above, present below)
  // emanate from the dot; unrelated lanes pass straight through.
  for (let k = 0; k < lanesAfter.length; k++) {
    if (lanesAfter[k] == null) continue;
    const x = laneX(k);
    const emanates = k === col || lanesBefore[k] == null;
    if (emanates) svg.appendChild(svgLine(cx, DOT_CY, x, BAND_H, laneColor(k)));
    else svg.appendChild(svgLine(x, DOT_CY, x, BAND_H, laneColor(k)));
  }

  if (node) {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', DOT_CY);
    dot.setAttribute('r', DOT_R);
    if (dotClass) dot.setAttribute('class', dotClass);
    else { dot.setAttribute('fill', color); dot.setAttribute('stroke', 'var(--panel-1)'); dot.setAttribute('stroke-width', '1.5'); }
    svg.appendChild(dot);
  }
  rail.appendChild(svg);

  // Filler: full-height vertical line per outgoing lane, stretching with the row.
  const filler = document.createElement('div');
  filler.className = 'rail-filler';
  filler.style.top = `${BAND_H}px`; // keep in lockstep with the band height
  for (let k = 0; k < lanesAfter.length; k++) {
    if (lanesAfter[k] == null) continue;
    const line = document.createElement('div');
    line.className = 'rail-line';
    line.style.left = `${laneX(k) - 1}px`;
    line.style.background = laneColor(k);
    filler.appendChild(line);
  }
  rail.appendChild(filler);
  return rail;
}

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
  // pushState updates the URL without firing hashchange, so no event handler
  // can race with show()/loadCommits() and accidentally close the view.
  history.pushState(null, '', '#commits');
  show();
  loadCommits();
}

// Synthetic "working tree" row for uncommitted changes. Visually distinct
// from real commits: amber accent, no SHA, no date.
function renderUncommittedRow(project, onOpenCommit, { headCol = null, maxCols = 0 } = {}) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'commit-row uncommitted';

  // Connect the working-tree row into HEAD's lane: a hollow amber dot whose lane
  // continues down into commit[0]'s column. Built only when a graph is present.
  if (maxCols > 0 && headCol != null) {
    const lanesAfter = [];
    for (let k = 0; k < headCol; k++) lanesAfter.push(null);
    lanesAfter[headCol] = 'WORKING_TREE';
    const layout = {
      sha: null, col: headCol, color: 'var(--amber)', lanesBefore: [], lanesAfter,
    };
    row.appendChild(buildRail(layout, maxCols, { dotClass: 'rail-dot-uncommitted' }));
  }

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

function renderRow(project, commit, onOpenCommit, { ahead = false, layout = null, maxCols = 0 } = {}) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = ahead ? 'commit-row ahead' : 'commit-row';

  if (maxCols > 0) row.appendChild(buildRail(layout, maxCols));

  const sha = document.createElement('span');
  sha.className = 'commit-sha';
  sha.textContent = commit.shortSha;

  const subject = document.createElement('span');
  subject.className = 'commit-subject';
  subject.title = commit.subject;
  subject.textContent = commit.subject;

  const meta = document.createElement('div');
  meta.className = 'commit-meta';
  const authorEl = document.createElement('span');
  authorEl.className = 'commit-author';
  authorEl.textContent = commit.author;
  const dateEl = document.createElement('span');
  dateEl.className = 'commit-date';
  dateEl.textContent = commit.relativeDate;
  meta.append(authorEl, dateEl);

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

  // Compute the branch/merge graph once over the returned commits.
  const { rows: graphRows, maxCols } = computeGraph(data.commits);
  const railWidth = maxCols > 0 ? maxCols * LANE_W : 0;

  // Uncommitted changes synthetic entry at the very top, connected into HEAD's lane.
  if (data.hasUncommitted) {
    listEl.appendChild(renderUncommittedRow(project, api.onOpenCommit, {
      headCol: graphRows[0]?.col ?? null, maxCols,
    }));
  }

  // How many of the shown commits are "ahead" of the base.
  const effectiveAheadCount = Math.min(data.aheadCount ?? 0, data.commits.length);

  for (let i = 0; i < data.commits.length; i++) {
    // Divider between ahead commits and already-merged commits. Inset its label
    // by the rail width so it stays aligned with the rows' text columns.
    if (effectiveAheadCount > 0 && i === effectiveAheadCount) {
      const divider = document.createElement('div');
      divider.className = 'ahead-divider';
      divider.textContent = `in ${data.aheadOf}`;
      if (railWidth) divider.style.paddingLeft = `${railWidth + 12}px`;
      listEl.appendChild(divider);
    }
    listEl.appendChild(renderRow(project, data.commits[i], api.onOpenCommit, {
      ahead: i < effectiveAheadCount,
      layout: graphRows[i], maxCols,
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
