// installPruneDialog — wires the #prune-dialog modal (⋮ → 🪒 Prune).
// Returns { open } which the caller binds to the overflow item.
//
// The savings readout is computed CLIENT-SIDE from a single
// GET /api/instances/:id/prune/analysis payload: the server returns per-turn,
// per-category prunable-token counts, so dragging the slider or flipping a
// tickbox is arithmetic on data we already hold — no round-trip per drag, and the
// per-category breakdown (which is what makes the tickboxes decidable) is free.
// The per-turn counts are raw estimates; every displayed figure is a sum scaled
// by the payload's `calibration.factor` and rounded — the same arithmetic the
// transform applies to what it reports as saved. The percentage is taken against
// `contextTokens`, the ctx chip's own reading, and is omitted when there is none.
//
// Slider semantics: the value is a `cutTurnIndex` in the SAME index space
// fork/rewind use (pure user-prompt lines). Turns [0, cut) get pruned; the max is
// turnCount, so a full prune (newest turn included) is reachable — but the
// DEFAULT stays at turnCount-1, so shedding the newest turn is a deliberate drag
// to the far right. Because the cut can only land on a turn boundary, it is
// structurally impossible for it to fall between a tool_use and its tool_result.

import { apiFetch } from './http.js';
import { formatTokens } from './usage.js';

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

  const calibrated = (raw) => Math.round(raw * analysis.calibration.factor);

  // Sum the prefix the slider selects. Thinking is global — summed over ALL
  // turns, not just the pruned prefix — because thinking staleness is
  // categorical, not temporal.
  function computeSavings() {
    if (!analysis) return { thinking: 0, toolInputs: 0, toolOutputs: 0, exempt: 0, total: 0 };
    const cut = Number(cutEl.value);
    const minimal = minimalEl.checked;
    let toolInputs = 0;
    let toolOutputs = 0;
    let toolOutputImage = 0;
    let exempt = 0;
    for (const t of analysis.turns.slice(0, cut)) {
      toolInputs += minimal ? t.toolInputMinimal : t.toolInputTruncatable;
      toolOutputs += t.toolOutput;
      toolOutputImage += t.toolOutputImage;
      exempt += t.exempt;
    }
    const thinking = thinkingEl.checked
      ? calibrated(analysis.turns.reduce((a, t) => a + t.thinking, 0))
      : 0;
    toolInputs = calibrated(toolInputs);
    // An image's saving is a real cost already, never scaled (see sessionPrune.ts pruneBlock).
    toolOutputs = calibrated(toolOutputs - toolOutputImage) + toolOutputImage;
    return { thinking, toolInputs, toolOutputs, exempt: calibrated(exempt), total: thinking + toolInputs + toolOutputs };
  }

  function renderSavings() {
    const cut = Number(cutEl.value);
    cutLabel.textContent = analysis ? `${cut} of ${analysis.turnCount}` : String(cut);
    const s = computeSavings();
    savingsEl.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'stats-table';
    const tbody = document.createElement('tbody');
    const tokens = (n) => `~${formatTokens(n)} tokens`;
    // Encrypted thinking is in context but Prune never rewrites it, so a zero
    // there is "not removable", not "nothing to remove".
    const encrypted = analysis ? calibrated(analysis.encryptedThinking) : 0;
    const rows = [
      ['Thinking', s.thinking === 0 && encrypted > 0
        ? `n/a — stored encrypted (~${formatTokens(encrypted)} in context, kept)`
        : tokens(s.thinking)],
      ['Tool inputs', tokens(s.toolInputs)],
      ['Tool outputs', tokens(s.toolOutputs)],
      // Explains a near-zero tool figure on a conductor's orchestration-heavy turns.
      ...(s.exempt > 0 ? [['Kept — orchestration calls (exempt)', tokens(s.exempt)]] : []),
      ['Estimated total saved', tokens(s.total)],
    ];
    for (const [label, value] of rows) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = label;
      const td2 = document.createElement('td');
      td2.textContent = value;
      tr.append(td1, td2);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    savingsEl.appendChild(table);

    if (analysis) {
      const ctx = analysis.contextTokens;
      const p = document.createElement('p');
      p.className = 'settings-hint';
      p.textContent = (ctx > 0
        ? `~${Math.round((s.total / ctx) * 100)}% of current context (${formatTokens(ctx)} tokens — the ctx chip's reading). `
        : 'No current context reading yet — it returns after the session\'s next turn. ')
        + (analysis.calibration.calibrated
          ? 'Calibrated against this session\'s real token usage. '
          : 'Uncalibrated estimate — not enough usage history yet. ')
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
    // Reset every control, not just the slider — the HTML `checked` attribute is
    // only the FIRST-open default, so without this a previous prune's tickbox
    // choices silently carry into the next one.
    thinkingEl.checked = true;
    minimalEl.checked = false;
    savingsEl.textContent = 'Analysing session…';
    applyBtn.disabled = true;
    applyBtn.textContent = 'Prune';
    if (!dialog.open) dialog.showModal();
    try {
      analysis = await apiFetch(`/api/instances/${encodeURIComponent(id)}/prune/analysis`);
    } catch (e) {
      savingsEl.textContent = '';
      showError(`Could not analyse this session: ${e.message}`);
      return;
    }
    if (analysis.turnCount < 1) {
      savingsEl.textContent = '';
      showError('Nothing to prune yet — this session has no completed turns.');
      return;
    }
    cutEl.min = '0';
    cutEl.max = String(analysis.turnCount);
    // Default to the brief's 90%, snapped to a turn boundary and capped so the
    // newest turn survives unless the user drags past it.
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
      await apiFetch(`/api/instances/${encodeURIComponent(id)}/prune`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cutTurnIndex: Number(cutEl.value),
          pruneThinking: thinkingEl.checked,
          inputMode: minimalEl.checked ? 'minimal' : 'truncate',
        }),
      });
      // The instance keeps its id AND its sessionId (only the internal backing
      // id rotated), so focus is
      // already correct — the snapshot_reset from the respawn clears and replays
      // the pruned transcript. Just re-sync the sidebar so the archived original
      // land in the right places.
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
