// installPruneDialog — wires the #prune-dialog modal (⋮ → 🪒 Prune).
// Returns { open } which the caller binds to the overflow item.
//
// The savings readout is computed CLIENT-SIDE from a single
// GET /api/instances/:id/prune/analysis payload: the server returns per-turn,
// per-category prunable-token counts, so dragging the slider or flipping a
// tickbox is arithmetic on data we already hold — no round-trip per drag, and the
// per-category breakdown (which is what makes the tickboxes decidable) is free.
//
// Slider semantics: the value is a `cutTurnIndex` in the SAME index space
// fork/rewind use (pure user-prompt lines). Turns [0, cut) get pruned; the max is
// turnCount-1, so the newest turn is always left verbatim — the "cap below 100%"
// rule. Because the cut can only land on a turn boundary, it is structurally
// impossible for it to fall between an assistant's tool_use and its tool_result.

export function installPruneDialog({ dom, getActiveId, refreshInstances }) {
  const dialog = dom.pruneDialog;
  const cutEl = document.getElementById('pd-cut');
  const cutLabel = document.getElementById('pd-cut-label');
  const thinkingEl = document.getElementById('pd-thinking');
  const minimalEl = document.getElementById('pd-minimal');
  const savingsEl = document.getElementById('pd-savings');
  const errorEl = document.getElementById('pd-error');
  const applyBtn = document.getElementById('pd-apply');

  let analysis = null;
  let busy = false;

  function showError(msg) {
    errorEl.textContent = msg ?? '';
    errorEl.hidden = !msg;
  }

  const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  // Sum the prefix the slider selects. Thinking is global — summed over ALL
  // turns, not just the pruned prefix — because thinking staleness is
  // categorical, not temporal.
  function computeSavings() {
    if (!analysis) return { thinking: 0, toolInputs: 0, toolOutputs: 0, total: 0 };
    const cut = Number(cutEl.value);
    const minimal = minimalEl.checked;
    let toolInputs = 0;
    let toolOutputs = 0;
    for (const t of analysis.turns.slice(0, cut)) {
      toolInputs += minimal ? t.toolInputMinimal : t.toolInputTruncatable;
      toolOutputs += t.toolOutput;
    }
    const thinking = thinkingEl.checked
      ? analysis.turns.reduce((a, t) => a + t.thinking, 0)
      : 0;
    return { thinking, toolInputs, toolOutputs, total: thinking + toolInputs + toolOutputs };
  }

  function renderSavings() {
    const cut = Number(cutEl.value);
    cutLabel.textContent = analysis ? `${cut} of ${analysis.turnCount}` : String(cut);
    const s = computeSavings();
    savingsEl.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'stats-table';
    const tbody = document.createElement('tbody');
    const rows = [
      ['Thinking', s.thinking],
      ['Tool inputs', s.toolInputs],
      ['Tool outputs', s.toolOutputs],
      ['Estimated total saved', s.total],
    ];
    for (const [label, value] of rows) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = label;
      const td2 = document.createElement('td');
      td2.textContent = `~${fmtTokens(value)} tokens`;
      tr.append(td1, td2);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    savingsEl.appendChild(table);

    if (analysis?.totalTokens > 0) {
      const pct = Math.round((s.total / analysis.totalTokens) * 100);
      const p = document.createElement('p');
      p.className = 'settings-hint';
      p.textContent = `~${pct}% of this session's estimated conversation tokens. `
        + 'Sub-agent transcripts are excluded — they are not in this session\'s context.';
      savingsEl.appendChild(p);
    }
    applyBtn.disabled = busy || !analysis || s.total <= 0;
  }

  async function open() {
    const id = getActiveId();
    if (!id) return;
    analysis = null;
    busy = false;
    showError('');
    savingsEl.textContent = 'Analysing session…';
    applyBtn.disabled = true;
    applyBtn.textContent = 'Prune';
    if (!dialog.open) dialog.showModal();
    try {
      const r = await fetch(`/api/instances/${encodeURIComponent(id)}/prune/analysis`);
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      analysis = await r.json();
    } catch (e) {
      savingsEl.textContent = '';
      showError(`Could not analyse this session: ${e.message}`);
      return;
    }
    if (analysis.turnCount < 2) {
      savingsEl.textContent = '';
      showError('Nothing to prune yet — a session needs at least two turns '
        + '(the newest turn is always left verbatim).');
      return;
    }
    cutEl.min = '0';
    cutEl.max = String(analysis.turnCount - 1);
    // Default to the brief's 90%, snapped to a turn boundary and capped so the
    // newest turn survives.
    cutEl.value = String(Math.min(
      analysis.turnCount - 1,
      Math.max(1, Math.round(analysis.turnCount * 0.9)),
    ));
    renderSavings();
  }

  async function apply() {
    const id = getActiveId();
    if (!id || !analysis || busy) return;
    busy = true;
    applyBtn.disabled = true;
    applyBtn.textContent = 'Pruning…';
    showError('');
    try {
      const r = await fetch(`/api/instances/${encodeURIComponent(id)}/prune`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cutTurnIndex: Number(cutEl.value),
          pruneThinking: thinkingEl.checked,
          inputMode: minimalEl.checked ? 'minimal' : 'truncate',
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      await r.json();
      // The instance keeps its id (only the sessionId rotated), so focus is
      // already correct — the snapshot_reset from the respawn clears and replays
      // the pruned transcript. Just re-sync the sidebar so the archived original
      // and the new sessionId land in the right places.
      await refreshInstances();
      dialog.close();
    } catch (e) {
      showError(`Prune failed: ${e.message}`);
    } finally {
      busy = false;
      applyBtn.textContent = 'Prune';
      renderSavings();
    }
  }

  cutEl.addEventListener('input', renderSavings);
  thinkingEl.addEventListener('change', renderSavings);
  minimalEl.addEventListener('change', renderSavings);
  applyBtn.addEventListener('click', apply);

  return { open };
}
