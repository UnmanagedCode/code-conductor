// The sidebar's Conductors / Projects lens toggle. Presentation only: sidebar.js
// renders both lists on every render, and the lens just sets
// `#sidebar[data-lens]`, which styles.css turns into which list (and which
// lens-only controls) show. The choice is a per-browser preference.

const LENS_STORAGE_KEY = 'code-conductor:sidebar-lens';
const LENSES = ['conductors', 'projects'];
const DEFAULT_LENS = 'conductors';

function loadLens() {
  try {
    const v = localStorage.getItem(LENS_STORAGE_KEY);
    return LENSES.includes(v) ? v : DEFAULT_LENS;
  } catch {
    return DEFAULT_LENS;
  }
}
function saveLens(lens) {
  try { localStorage.setItem(LENS_STORAGE_KEY, lens); } catch { /* private mode / quota — best-effort */ }
}

export function installSidebarLens({ dom, closeSidebarOverflow }) {
  function apply(lens) {
    dom.sidebar.dataset.lens = lens;
    for (const btn of dom.sidebarLensButtons) {
      btn.setAttribute('aria-pressed', btn.dataset.lens === lens ? 'true' : 'false');
    }
  }
  apply(loadLens());
  for (const btn of dom.sidebarLensButtons) {
    btn.addEventListener('click', () => {
      const lens = btn.dataset.lens;
      if (!LENSES.includes(lens)) return;
      apply(lens);
      saveLens(lens);
      // The ≡ menu lives in the Projects-only row; an open panel must not stay
      // armed inside a hidden row.
      if (lens === 'conductors') closeSidebarOverflow();
    });
  }
}
