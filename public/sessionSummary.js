import { renderMarkdownInto } from './markdown.js';
import { fmtCost } from './usage.js';

// installSessionSummary — wires the #summary-dialog modal.
// Returns { open } which the caller binds to the "Summarize session" button.
//
// GET /summary returns all tiers at once. Tier buttons switch
// instantly between cached summaries — no extra network call per tier.
// Generate button POSTs for the selected tier; the response returns all
// tiers so the local cache is refreshed in one round-trip.
export function installSessionSummary({ dom, getActiveSid, applySessionTitle }) {
  const dialog = dom.summaryDialog;
  const contentEl = document.getElementById('summary-content');
  const generateBtn = document.getElementById('summary-generate-btn');
  const applyBtn = document.getElementById('summary-apply-title-btn');
  const staleBadge = document.getElementById('summary-stale-badge');
  const costEl = document.getElementById('summary-cost');
  const errorEl = document.getElementById('summary-error');
  const tierBtns = [...dialog.querySelectorAll('.summary-tier-selector button[data-len]')];

  // Client-side cache: { short: {summary,generatedAt,messageCount,isStale}|null, medium: …, long: …, title: … }
  let cachedData = null;
  let selectedLength = 'medium';

  function setTier(len) {
    selectedLength = len;
    for (const b of tierBtns) b.classList.toggle('active', b.dataset.len === len);
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  // Ephemeral: the cost of the last generation in this dialog session. Never persisted,
  // never returned by GET, so it clears on open and on any tier switch.
  function setCost(usd) {
    const show = typeof usd === 'number';
    costEl.textContent = show ? `Cost: ${fmtCost(usd)}` : '';
    costEl.hidden = !show;
  }

  // Render the currently selected tier from the local cache.
  function renderSelectedTier() {
    showError('');
    const tier = cachedData?.[selectedLength] ?? null;
    contentEl.innerHTML = '';
    if (tier) {
      renderMarkdownInto(contentEl, tier.summary);
      staleBadge.hidden = !tier.isStale;
      generateBtn.textContent = '↺ Regenerate';
    } else {
      staleBadge.hidden = true;
      generateBtn.textContent = 'Generate summary';
    }
    generateBtn.disabled = false;
    applyBtn.hidden = !(selectedLength === 'title' && tier);
    applyBtn.disabled = false;
    applyBtn.textContent = '✏️ Use as session title';
  }

  // Update the cache and re-render. Picks the default tier:
  //   - selectedLength if it has a summary, else medium, else first available.
  function applyData(data, preferLen) {
    cachedData = data;
    const TIERS = ['title', 'short', 'medium', 'long']; // left-to-right dialog order
    const target = preferLen ?? selectedLength;
    if (data[target]) {
      setTier(target);
    } else if (data['medium']) {
      setTier('medium');
    } else {
      const first = TIERS.find(l => data[l]);
      setTier(first ?? 'medium');
    }
    renderSelectedTier();
  }

  // Clicking a tier button: instant switch from cache, no network call.
  for (const btn of tierBtns) {
    btn.addEventListener('click', () => {
      if (generateBtn.disabled) return; // generating in progress
      setCost(null);
      setTier(btn.dataset.len);
      renderSelectedTier();
    });
  }

  generateBtn.addEventListener('click', async () => {
    const sid = getActiveSid();
    if (!sid) return;
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating…';
    showError('');
    setCost(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ length: selectedLength }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setCost(body.costUsd);
      // POST returns the same tier shape as GET; update cache and re-render.
      applyData(body.data, selectedLength);
    } catch (e) {
      showError('Generation failed: ' + e.message);
      generateBtn.disabled = false;
      generateBtn.textContent = cachedData?.[selectedLength] ? '↺ Regenerate' : 'Generate summary';
    }
  });

  applyBtn.addEventListener('click', async () => {
    const sid = getActiveSid();
    const title = cachedData?.title?.summary;
    if (!sid || !title) return;
    applyBtn.disabled = true;
    showError('');
    try {
      await applySessionTitle(sid, title);
      applyBtn.textContent = '✓ Applied';
    } catch (e) {
      showError('Failed to set title: ' + e.message);
      applyBtn.disabled = false;
    }
  });

  async function open() {
    const sid = getActiveSid();
    if (!sid) return;

    // Reset to loading state.
    cachedData = null;
    contentEl.innerHTML = '<span class="summary-loading">Loading…</span>';
    staleBadge.hidden = true;
    setCost(null);
    showError('');
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generate summary';
    applyBtn.hidden = true;
    setTier('medium');

    dialog.showModal();

    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/summary`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      applyData(body.data, null);
    } catch (e) {
      contentEl.innerHTML = '';
      showError('Failed to load: ' + e.message);
      generateBtn.disabled = false;
    }
  }

  return { open };
}
