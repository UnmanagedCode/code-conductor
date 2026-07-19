// Cost dashboard view — full-page breakdown of spend by project, model, and
// time. Mount point: <section id="costs-view">. Built on the shared
// installHashView scaffold: installCosts() returns { open(), close() }.

import { installHashView } from './hashView.js';
import { formatDuration } from './usage.js';

let _onClose = null;

function getEl(id) { return document.getElementById(id); }

function fmtExact(n) {
  return `$${n.toFixed(4)}`;
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

async function load() {
  const bodyEl = getEl('costs-body');
  if (!bodyEl) return;
  bodyEl.textContent = 'Loading…';
  try {
    const r = await fetch('/api/costs/summary', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    render(await r.json());
  } catch (e) {
    bodyEl.textContent = `Failed to load: ${e.message}`;
  }
}

function render(data) {
  const bodyEl = getEl('costs-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = '';

  // Total
  const totalEl = document.createElement('div');
  totalEl.className = 'costs-total';
  totalEl.textContent = data.row_count === 0
    ? 'No cost data recorded yet — cost tracking begins with the next turn.'
    : `Total spend: ${fmtExact(data.total_usd)} across ${data.row_count} turn${data.row_count === 1 ? '' : 's'}`;
  bodyEl.appendChild(totalEl);

  if (data.row_count === 0) return;

  // By project (expandable rows with per-model breakdown)
  const projSection = document.createElement('section');
  projSection.className = 'costs-section';
  const projH = document.createElement('h2');
  projH.textContent = 'By project';
  projSection.appendChild(projH);
  const projTable = document.createElement('table');
  projTable.className = 'costs-table';
  const projThead = document.createElement('thead');
  const projHeadRow = document.createElement('tr');
  for (const h of ['Project', 'Cost', 'Turns', 'Sessions', 'Cache misses', 'LLM time', 'Walltime']) {
    const th = document.createElement('th');
    th.textContent = h;
    projHeadRow.appendChild(th);
  }
  projThead.appendChild(projHeadRow);
  projTable.appendChild(projThead);
  const projTbody = document.createElement('tbody');
  for (const p of data.by_project) {
    const projRow = document.createElement('tr');
    projRow.className = 'costs-proj-row';

    const nameTd = document.createElement('td');
    const caret = document.createElement('span');
    caret.className = 'costs-caret';
    caret.textContent = '▶';
    nameTd.appendChild(caret);
    nameTd.appendChild(document.createTextNode(p.project));
    projRow.appendChild(nameTd);

    const costTd = document.createElement('td');
    costTd.textContent = fmtExact(p.cost_usd);
    projRow.appendChild(costTd);

    const turnsTd = document.createElement('td');
    turnsTd.textContent = String(p.turns);
    projRow.appendChild(turnsTd);

    const sessionsTd = document.createElement('td');
    sessionsTd.textContent = String(p.sessions);
    projRow.appendChild(sessionsTd);

    const missesTd = document.createElement('td');
    missesTd.textContent = String(p.cache_misses);
    projRow.appendChild(missesTd);

    const apiTd = document.createElement('td');
    apiTd.textContent = formatDuration(p.duration_api_ms);
    projRow.appendChild(apiTd);

    const wallTd = document.createElement('td');
    wallTd.textContent = formatDuration(p.duration_ms);
    projRow.appendChild(wallTd);

    const detailRow = document.createElement('tr');
    detailRow.className = 'costs-proj-detail';
    detailRow.hidden = true;
    const detailTd = document.createElement('td');
    detailTd.colSpan = 7;
    detailTd.appendChild(makeTable(
      ['Model', 'Cost', 'Input', 'Output', 'Cache create', 'Cache read', 'Turns', 'Sessions', 'Cache misses', 'LLM time', 'Walltime'],
      (p.by_model ?? []).map(m => [
        m.model,
        fmtExact(m.cost_usd),
        fmtNum(m.input_tokens),
        fmtNum(m.output_tokens),
        fmtNum(m.cache_creation_tokens),
        fmtNum(m.cache_read_tokens),
        String(m.turns),
        String(m.sessions),
        String(m.cache_misses),
        formatDuration(m.duration_api_ms),
        formatDuration(m.duration_ms),
      ]),
    ));
    detailRow.appendChild(detailTd);

    projRow.addEventListener('click', () => {
      const open = projRow.classList.toggle('costs-proj-row--open');
      detailRow.hidden = !open;
    });

    projTbody.appendChild(projRow);
    projTbody.appendChild(detailRow);
  }
  projTable.appendChild(projTbody);
  projSection.appendChild(projTable);
  bodyEl.appendChild(projSection);

  // By model
  const modelSection = document.createElement('section');
  modelSection.className = 'costs-section';
  const modelH = document.createElement('h2');
  modelH.textContent = 'By model';
  modelSection.appendChild(modelH);
  modelSection.appendChild(makeTable(
    ['Model', 'Cost', 'Input', 'Output', 'Cache create', 'Cache read', 'Turns', 'Sessions', 'Cache misses', 'LLM time', 'Walltime'],
    data.by_model.map(m => [
      m.model,
      fmtExact(m.cost_usd),
      fmtNum(m.input_tokens),
      fmtNum(m.output_tokens),
      fmtNum(m.cache_creation_tokens),
      fmtNum(m.cache_read_tokens),
      String(m.turns),
      String(m.sessions),
      String(m.cache_misses),
      formatDuration(m.duration_api_ms),
      formatDuration(m.duration_ms),
    ]),
  ));
  bodyEl.appendChild(modelSection);

  // Daily trend
  if (data.daily_trend.length > 0) {
    const trendSection = document.createElement('section');
    trendSection.className = 'costs-section';
    const trendH = document.createElement('h2');
    trendH.textContent = 'Daily spend';
    trendSection.appendChild(trendH);
    const maxDay = Math.max(...data.daily_trend.map(d => d.cost_usd));
    const barsEl = document.createElement('div');
    barsEl.className = 'costs-bars';
    for (const day of data.daily_trend) {
      const row = document.createElement('div');
      row.className = 'costs-bar-row';
      const label = document.createElement('span');
      label.className = 'costs-bar-label';
      label.textContent = day.date;
      const bar = document.createElement('div');
      bar.className = 'costs-bar';
      const pct = maxDay > 0 ? (day.cost_usd > 0 ? Math.max(1, Math.round((day.cost_usd / maxDay) * 100)) : 0) : 0;
      bar.style.setProperty('--costs-bar-pct', `${pct}%`);
      const val = document.createElement('span');
      val.className = 'costs-bar-val';
      val.textContent = fmtExact(day.cost_usd);
      row.appendChild(label);
      row.appendChild(bar);
      row.appendChild(val);
      barsEl.appendChild(row);
    }
    trendSection.appendChild(barsEl);
    bodyEl.appendChild(trendSection);
  }
}

function makeTable(headers, rows) {
  const table = document.createElement('table');
  table.className = 'costs-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const cells of rows) {
    const tr = document.createElement('tr');
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

export function installCosts({ onClose } = {}) {
  _onClose = onClose;

  // guard: the #costs-view element may be absent in some layouts; gate both
  // open() and teardown on its presence (matches the originals' getEl checks).
  return installHashView({
    name: 'costs',
    escapeCapture: true,
    guard: () => !!getEl('costs-view'),
    navigate: () => history.pushState({}, '', '#costs'),
    onShow: () => load(),
    onTeardown: () => { _onClose?.(); },
  });
}
