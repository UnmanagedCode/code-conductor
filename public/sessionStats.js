import { formatDuration } from './usage.js';

// installSessionStats — wires the #stats-dialog modal.
// Returns { open } which the caller binds to the "Statistics" overflow item.
//
// GET /api/costs/session/:sessionId returns cost/timing for the active session
// alone (`own`) and rolled up to include every worker it spawned (`rolled`),
// plus `workerSessions` (the descendant-session count folded into the rollup).
export function installSessionStats({ dom, getActiveSid }) {
  const dialog = dom.statsDialog;
  const contentEl = document.getElementById('stats-content');
  const errorEl = document.getElementById('stats-error');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  const fmtCost = (n) => `$${(n ?? 0).toFixed(4)}`;

  function render(data) {
    showError('');
    contentEl.innerHTML = '';

    const hasWorkers = (data.workerSessions ?? 0) > 0;
    const table = document.createElement('table');
    table.className = 'stats-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const heads = hasWorkers
      ? ['', 'This session', `Incl. ${data.workerSessions} worker${data.workerSessions === 1 ? '' : 's'}`]
      : ['', 'This session'];
    for (const h of heads) {
      const th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const metrics = [
      ['Cost', (m) => fmtCost(m.cost_usd)],
      ['LLM time', (m) => formatDuration(m.duration_api_ms)],
      ['Turn walltime', (m) => formatDuration(m.duration_ms)],
    ];
    for (const [label, fmt] of metrics) {
      const tr = document.createElement('tr');
      const labelTd = document.createElement('td');
      labelTd.textContent = label;
      tr.appendChild(labelTd);
      const ownTd = document.createElement('td');
      ownTd.textContent = fmt(data.own);
      tr.appendChild(ownTd);
      if (hasWorkers) {
        const rolledTd = document.createElement('td');
        rolledTd.textContent = fmt(data.rolled);
        tr.appendChild(rolledTd);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    contentEl.appendChild(table);

    if (!hasWorkers) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'No worker sessions spawned from this session.';
      contentEl.appendChild(note);
    }
  }

  async function open() {
    const sid = getActiveSid();
    if (!sid) return;

    contentEl.innerHTML = '<span class="stats-loading">Loading…</span>';
    showError('');
    dialog.showModal();

    try {
      const r = await fetch(`/api/costs/session/${encodeURIComponent(sid)}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      render(body);
    } catch (e) {
      contentEl.innerHTML = '';
      showError('Failed to load: ' + e.message);
    }
  }

  return { open };
}
