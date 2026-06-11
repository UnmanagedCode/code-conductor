// Cost dashboard view — full-page breakdown of spend by project, model, and
// time. Mount point: <section id="costs-view">. Follows the installCommits /
// installReview pattern: installCosts() returns { open(), close() }.

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

  // By project
  const projSection = document.createElement('section');
  projSection.className = 'costs-section';
  const projH = document.createElement('h2');
  projH.textContent = 'By project';
  projSection.appendChild(projH);
  projSection.appendChild(makeTable(
    ['Project', 'Cost', 'Turns'],
    data.by_project.map(p => [p.project, fmtExact(p.cost_usd), String(p.turns)]),
  ));
  bodyEl.appendChild(projSection);

  // By model
  const modelSection = document.createElement('section');
  modelSection.className = 'costs-section';
  const modelH = document.createElement('h2');
  modelH.textContent = 'By model';
  modelSection.appendChild(modelH);
  modelSection.appendChild(makeTable(
    ['Model', 'Cost', 'Input', 'Output', 'Cache create', 'Cache read', 'Turns'],
    data.by_model.map(m => [
      m.model,
      fmtExact(m.cost_usd),
      fmtNum(m.input_tokens),
      fmtNum(m.output_tokens),
      fmtNum(m.cache_creation_tokens),
      fmtNum(m.cache_read_tokens),
      String(m.turns),
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
      bar.style.setProperty('--costs-bar-pct', `${Math.round((day.cost_usd / maxDay) * 100)}%`);
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

function show() {
  getEl('costs-view').hidden = false;
  getEl('main').classList.add('costs-open');
}

function hide() {
  getEl('costs-view').hidden = true;
  getEl('main').classList.remove('costs-open');
}

function open() {
  if (!getEl('costs-view')) return;
  history.pushState({}, '', '#costs');
  show();
  load();
}

function close() {
  if (!getEl('costs-view')) return;
  hide();
  _onClose?.();
}

export function installCosts({ onClose } = {}) {
  _onClose = onClose;

  getEl('costs-back')?.addEventListener('click', () => history.back());

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !getEl('costs-view')?.hidden) {
      history.back();
    }
  }, true);

  window.addEventListener('hashchange', () => {
    if (location.hash !== '#costs' && !getEl('costs-view')?.hidden) {
      close();
    }
  });

  return { open, close };
}
