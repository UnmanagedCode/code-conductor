import { renderMarkdownInto } from './markdown.js';

// installSessionSummary — wires the #summary-dialog modal.
// Returns { open } which the caller binds to the "Summarize session" button.
//
// GET /summary returns all three tiers at once. Tier buttons switch
// instantly between cached summaries — no extra network call per tier.
// Generate button POSTs for the selected tier; the response returns all
// three tiers so the local cache is refreshed in one round-trip.
export function installSessionSummary({ dom, getActiveSid }) {
  const dialog = dom.summaryDialog;
  const contentEl = document.getElementById('summary-content');
  const generateBtn = document.getElementById('summary-generate-btn');
  const staleBadge = document.getElementById('summary-stale-badge');
  const errorEl = document.getElementById('summary-error');
  const tierBtns = [...dialog.querySelectorAll('.summary-tier-selector button[data-len]')];

  // Client-side cache: { short: {summary,generatedAt,messageCount,isStale}|null, medium: …, long: … }
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
  }

  // Update the cache and re-render. Picks the default tier:
  //   - selectedLength if it has a summary, else medium, else first available.
  function applyData(data, preferLen) {
    cachedData = data;
    const TIERS = ['short', 'medium', 'long'];
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
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ length: selectedLength }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      // POST returns the same three-tier shape as GET; update cache and re-render.
      applyData(body.data, selectedLength);
    } catch (e) {
      showError('Generation failed: ' + e.message);
      generateBtn.disabled = false;
      generateBtn.textContent = cachedData?.[selectedLength] ? '↺ Regenerate' : 'Generate summary';
    }
  });

  async function open() {
    const sid = getActiveSid();
    if (!sid) return;

    // Reset to loading state.
    cachedData = null;
    contentEl.innerHTML = '<span class="summary-loading">Loading…</span>';
    staleBadge.hidden = true;
    showError('');
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generate summary';
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
