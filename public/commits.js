// Commit history view — a scrollable list of a project's commits (current
// branch / HEAD). Built on the shared installHashView scaffold: installCommits()
// returns { open(project, worktree?), close() }. Naming a worktree reads THAT
// checkout's history instead of the project's own tree — the only form that
// reaches a worktree of a project on a system. Tapping a commit row delegates to
// onOpenCommit(project, commit), which opens the shared diff renderer
// (review.js) on top, showing just that commit's change; the row carries its own
// `diffUrl`, so the worktree scoping travels with it.

import { installHashView } from './hashView.js';

let _project = null;
let _worktree = null;
let _onClose = null;

function getEl(id) { return document.getElementById(id); }

// The API prefix every commits request hangs off — the one place the
// project-scoped and worktree-scoped spellings differ.
export function commitsApiBase(project, worktree) {
  const base = `/api/projects/${encodeURIComponent(project)}`;
  return worktree ? `${base}/worktrees/${encodeURIComponent(worktree)}` : base;
}

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
// Left inset of a full-width element (the ahead divider) needed to line its text
// up with a .commit-row's text column, which starts after the rail. The two
// terms are `.commit-row`'s own `padding: 8px 12px` and `gap: 8px` in
// styles.css — retune them together (tests/commits-view.test.mjs pins both
// properties there, since no DOM assertion can measure the alignment).
const ROW_TEXT_INSET = 12 + 8;
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
// aligned from row to row. Parents ABSENT from the list (older than the cap /
// unfetched) are simply never matched: their lane stays active and trails off
// the bottom of the last row — that trail-off is the honest "history continues"
// signal, and applies only to parents absent from the list, never to one already
// drawn above (see the `seen` guard below).
//
// The newest-first precondition is GUARANTEED by the caller: getProjectCommits
// (src/worktrees.ts) passes --topo-order, so no parent precedes its child.
export function computeGraph(commits) {
  const activeLanes = []; // column -> sha targeted, or null
  const seen = new Set(); // every sha emitted above the current row
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

    // Route parents out of `col`. A parent ALREADY emitted above this row can
    // never be reached by continuing downward, so a lane aimed at it would run
    // to the bottom of the list without converging — a phantom line. Terminate
    // it here. A parent merely ABSENT from the list (older than the cap) is not
    // in `seen`, so its lane still trails off the bottom, which is the honest
    // "history continues" signal.
    if (parents.length === 0) {
      activeLanes[col] = null; // root: lane terminates
    } else {
      // first parent continues in the same column
      activeLanes[col] = seen.has(parents[0]) ? null : parents[0];
      for (let j = 1; j < parents.length; j++) {
        const pj = parents[j];
        if (seen.has(pj)) continue;
        if (activeLanes.indexOf(pj) === -1) activeLanes[firstFreeColumn()] = pj;
        // else: a lane already targets pj — the merge converges into it later.
      }
    }
    seen.add(sha);

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

// Pure helper: true when column k's outgoing segment must emanate FROM the dot
// rather than pass straight through. lanesBefore[k] === sha means that lane
// converged into this dot, freeing the slot for a freshly-routed parent —
// the new occupant must fork diagonally from the dot, not draw a straight line.
export function laneEmanates(k, col, lanesBefore, sha) {
  return k === col || lanesBefore[k] == null || lanesBefore[k] === sha;
}

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
    if (laneEmanates(k, col, lanesBefore, sha)) svg.appendChild(svgLine(cx, DOT_CY, x, BAND_H, laneColor(k)));
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

// Synthetic "working tree" row for uncommitted changes. Visually distinct
// from real commits: amber accent, no SHA, no date.
function renderUncommittedRow(project, apiBase, onOpenCommit, { headCol = null, maxCols = 0 } = {}) {
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
      diffUrl: `${apiBase}/commits/uncommitted/diff`,
    };
    onOpenCommit?.(project, synthCommit);
  });
  return row;
}

function renderRow(project, apiBase, commit, onOpenCommit, { ahead = false, layout = null, maxCols = 0 } = {}) {
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
  // The row hands out its own diff URL, as the working-tree row already does,
  // so the caller never has to rebuild the (project, worktree) spelling.
  const diffUrl = `${apiBase}/commits/${encodeURIComponent(commit.sha)}/diff`;
  row.addEventListener('click', () => onOpenCommit?.(project, { ...commit, diffUrl }));
  return row;
}

// Render the commit list DOM into `listEl` from a /commits payload. Split out of
// loadCommits (which owns the fetch and the title/stats lines) so divider
// placement, ahead classing and the graph rail are drivable without a network
// stub. `apiBase` is the prefix each row's `diffUrl` is built on; it defaults to
// the project-scoped spelling.
export function renderCommitList(listEl, data, { project, apiBase, onOpenCommit } = {}) {
  const base = apiBase ?? commitsApiBase(project);
  listEl.innerHTML = '';
  if (!data.commits || data.commits.length === 0) {
    if (data.hasUncommitted) {
      listEl.appendChild(renderUncommittedRow(project, base, onOpenCommit));
    }
    listEl.appendChild(Object.assign(document.createElement('div'), {
      className: 'review-empty', textContent: 'No commits',
    }));
    return;
  }

  // Compute the branch/merge graph once over the returned commits.
  const { rows: graphRows, maxCols } = computeGraph(data.commits);
  const railWidth = maxCols > 0 ? maxCols * LANE_W : 0;

  // Uncommitted changes synthetic entry at the very top, connected into HEAD's lane.
  if (data.hasUncommitted) {
    listEl.appendChild(renderUncommittedRow(project, base, onOpenCommit, {
      headCol: graphRows[0]?.col ?? null, maxCols,
    }));
  }

  // Each row's ahead/already-merged answer is the server's per-commit `ahead`
  // flag, never its position: the ahead set is NOT a prefix of the window.
  // Merging a moved-on base back into your branch interleaves already-merged
  // commits among ahead ones (git orders unrelated lines by date even under
  // --topo-order), so an index-based partition badges the wrong rows.
  //
  // The divider's label claims that everything BELOW it is already in the base,
  // so it is drawn only where that is true of every row below — i.e. the ahead
  // rows are a contiguous prefix, which is the ordinary case. Where they are
  // not, the per-row badges carry the answer alone rather than the divider
  // saying something false. `dividerAt` is -1 for "no divider" — a value no
  // row index can equal, so every not-drawn case is carried by this one
  // sentinel rather than by each branch below.
  const firstMerged = data.commits.findIndex(c => !c.ahead);
  const dividerAt = (data.aheadOf && firstMerged > 0
    && data.commits.slice(firstMerged).every(c => !c.ahead)) ? firstMerged : -1;

  for (let i = 0; i < data.commits.length; i++) {
    // Divider ABOVE the first already-merged row — it labels the section that
    // FOLLOWS it (border-top, ↓ glyph, left inset), so it is appended
    // immediately before that row. Inset its label past the rail so it lands on
    // the rows' text column (measured in a browser: rail + ROW_TEXT_INSET).
    if (i === dividerAt) {
      const divider = document.createElement('div');
      divider.className = 'ahead-divider';
      divider.textContent = `↓ already in ${data.aheadOf}`;
      if (railWidth) divider.style.paddingLeft = `${railWidth + ROW_TEXT_INSET}px`;
      listEl.appendChild(divider);
    }
    listEl.appendChild(renderRow(project, base, data.commits[i], onOpenCommit, {
      ahead: data.commits[i].ahead === true,
      layout: graphRows[i], maxCols,
    }));
  }
}

async function loadCommits() {
  const project = _project;
  if (!project) return;
  const worktree = _worktree;
  const apiBase = commitsApiBase(project, worktree);
  // The subject of the view, which is the WORKTREE when one was named — the
  // response's `project` is the parent, so rendering it would silently retitle
  // the view with something the user did not open.
  const subject = worktree || project;

  const listEl = getEl('commits-list');
  const titleEl = getEl('commits-title');
  const statsEl = getEl('commits-stats');

  titleEl.textContent = subject;
  statsEl.textContent = '';
  listEl.innerHTML = '';
  listEl.appendChild(Object.assign(document.createElement('div'), {
    className: 'review-loading', textContent: 'Loading commits…',
  }));

  let data;
  try {
    const res = await fetch(`${apiBase}/commits`, { cache: 'no-store' });
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

  if (data.branch) titleEl.textContent = `${subject} · ${data.branch}`;

  renderCommitList(listEl, data, { project, apiBase, onOpenCommit: api.onOpenCommit });

  // Stats line: commit count + ahead summary when applicable. statsEl is a
  // different element from listEl, so it can be written after the list.
  if (data.commits && data.commits.length > 0) {
    const parts = [`${data.commits.length} commit${data.commits.length === 1 ? '' : 's'}`];
    if (data.truncated) parts.push(`(showing latest ${data.limit})`);
    if (data.aheadCount > 0 && data.aheadOf) {
      parts.push(`· ${data.aheadCount} ahead of ${data.aheadOf}`);
    }
    statsEl.textContent = parts.join(' ');
  }
}

// Public handle. open(project, worktree?)/close are wired in installCommits; onOpenCommit is
// assigned by the caller after install (and read here by loadCommits), so the
// SAME object identity must be returned from installCommits.
const api = { open: null, close: null, onOpenCommit: null };

export function installCommits({ onClose } = {}) {
  _onClose = onClose;

  // Capture-phase Escape (escapeCapture:true) runs before review.js's
  // bubble-phase handler, so when the diff is layered on top (review-view
  // visible) we bail (canEscape) and let review handle Escape; otherwise we
  // close the commit list. keepOpenHashes keeps us open while #review is
  // layered on top — only tear down when navigating somewhere unrelated.
  // pushState (in navigate) updates the URL without firing hashchange, so no
  // handler can race with show()/loadCommits() and accidentally close the view.
  const { open, close } = installHashView({
    name: 'commits',
    escapeCapture: true,
    keepOpenHashes: ['#review'],
    canEscape: () => getEl('review-view')?.hidden,
    navigate: () => history.pushState(null, '', '#commits'),
    onShow: (project, worktree) => { _project = project; _worktree = worktree ?? null; loadCommits(); },
    onLeave: () => { _onClose?.(); },
    onTeardown: () => { _project = null; _worktree = null; },
  });
  api.open = open;
  api.close = close;
  return api;
}
