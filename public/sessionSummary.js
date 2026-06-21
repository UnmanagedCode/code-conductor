import { renderMarkdownInto } from './markdown.js';

// installSessionSummary — wires the #summary-dialog modal.
// Returns { open } which the caller binds to the "Summarize session" button.
export function installSessionSummary({ dom, getActiveSid }) {
  const dialog = dom.summaryDialog;
  const contentEl = document.getElementById('summary-content');
  const generateBtn = document.getElementById('summary-generate-btn');
  const staleBadge = document.getElementById('summary-stale-badge');
  const errorEl = document.getElementById('summary-error');
  const tierBtns = [...dialog.querySelectorAll('.summary-tier-selector button[data-len]')];

  let selectedLength = 'medium';

  function setTier(len) {
    selectedLength = len;
    for (const b of tierBtns) {
      b.classList.toggle('active', b.dataset.len === len);
    }
  }

  for (const btn of tierBtns) {
    btn.addEventListener('click', () => setTier(btn.dataset.len));
  }

  function setGenerating(on) {
    generateBtn.disabled = on;
    generateBtn.textContent = on ? 'Generating…' : (contentEl.childNodes.length ? '↺ Regenerate' : 'Generate summary');
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function populateFrom(data) {
    showError('');
    if (data) {
      setTier(data.length ?? 'medium');
      contentEl.innerHTML = '';
      renderMarkdownInto(contentEl, data.summary);
      staleBadge.hidden = !data.isStale;
      generateBtn.textContent = '↺ Regenerate';
    } else {
      setTier('medium');
      contentEl.innerHTML = '';
      staleBadge.hidden = true;
      generateBtn.textContent = 'Generate summary';
    }
    generateBtn.disabled = false;
  }

  generateBtn.addEventListener('click', async () => {
    const sid = getActiveSid();
    if (!sid) return;
    setGenerating(true);
    showError('');
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ length: selectedLength }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      contentEl.innerHTML = '';
      renderMarkdownInto(contentEl, body.data.summary);
      staleBadge.hidden = true;
      generateBtn.textContent = '↺ Regenerate';
    } catch (e) {
      showError('Generation failed: ' + e.message);
    } finally {
      generateBtn.disabled = false;
    }
  });

  async function open() {
    const sid = getActiveSid();
    if (!sid) return;

    // Reset to a clean loading state while we fetch.
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
      populateFrom(body.data);
    } catch (e) {
      contentEl.innerHTML = '';
      showError('Failed to load: ' + e.message);
      generateBtn.disabled = false;
    }
  }

  return { open };
}
