// The chrome AROUND the sidebar: the mobile slide-over drawer (toggle + scrim),
// the desktop column's drag-resize handle and its persisted width, and the
// sidebar ≡ overflow menu. Distinct from sidebar.js, which owns the
// #project-list tree itself.
//
// Extracted from app.js. Installed early — right after the dom map — because
// closeSidebarOverflow is passed BY VALUE into installNewProjectDialog and
// installSpawnDialog, which only worked while it was a hoisted function
// declaration; as a handle method it has to exist before those calls run. The
// only install-time side effects are four addEventListener calls (on
// #sidebar-toggle, #sidebar-scrim, #sidebar-resize-handle and
// #sidebar-overflow-toggle — no other listener is registered on any of them
// anywhere in public/), one localStorage read and one --sidebar-width write.

import { makeDismissable } from './dismissable.js';

const SIDEBAR_WIDTH_STORAGE_KEY = 'code-conductor:sidebar-width';
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 560;

// The width clamp, named so the pin can exercise it directly. null means "no
// usable stored value" — the caller then leaves the CSS default in place rather
// than writing a fabricated width.
export function clampSidebarWidth(n) {
  return Number.isFinite(n) ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, n)) : null;
}

export function installSidebarChrome({ dom }) {
  function setSidebarOpen(open) {
    dom.sidebar.classList.toggle('open', open);
    dom.sidebarScrim.classList.toggle('open', open);
    dom.sidebarToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  dom.sidebarToggle.addEventListener('click', () => {
    setSidebarOpen(!dom.sidebar.classList.contains('open'));
  });
  // The sidebar is a slide-over drawer only below the 720px breakpoint (see
  // styles.css); above it, '.open' has no visual effect. Navigating to another
  // view (settings/review/commits/a session) should dismiss that mobile drawer
  // so the destination is visible, but must never collapse the always-visible
  // desktop column. Every navigation call site routes through this instead of
  // calling setSidebarOpen(false) directly, so the guard lives in one place.
  function closeSidebarOnMobile() {
    if (window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false);
  }

  // Sidebar resize (desktop grid layout only — the mobile drawer has a fixed
  // width and hides the handle via the @media breakpoint in styles.css).
  function loadSidebarWidth() {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
      const n = raw ? Number(raw) : NaN;
      return clampSidebarWidth(n);
    } catch {
      return null;
    }
  }
  function saveSidebarWidth(px) {
    try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(px)); } catch { /* private mode / quota — best-effort */ }
  }
  const savedSidebarWidth = loadSidebarWidth();
  if (savedSidebarWidth) document.documentElement.style.setProperty('--sidebar-width', `${savedSidebarWidth}px`);

  if (dom.sidebarResizeHandle) {
    dom.sidebarResizeHandle.addEventListener('pointerdown', (e) => {
      if (window.matchMedia('(max-width: 720px)').matches) return; // mobile drawer — handle is hidden/inert anyway
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = dom.sidebar.getBoundingClientRect().width;
      dom.sidebarResizeHandle.setPointerCapture(e.pointerId);
      dom.sidebarResizeHandle.classList.add('active');
      document.body.style.userSelect = 'none';
      const onMove = (moveEvent) => {
        const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + (moveEvent.clientX - startX)));
        document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
      };
      const onUp = () => {
        dom.sidebarResizeHandle.removeEventListener('pointermove', onMove);
        dom.sidebarResizeHandle.removeEventListener('pointerup', onUp);
        dom.sidebarResizeHandle.classList.remove('active');
        document.body.style.userSelect = '';
        const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'));
        if (Number.isFinite(width)) saveSidebarWidth(width);
      };
      dom.sidebarResizeHandle.addEventListener('pointermove', onMove);
      dom.sidebarResizeHandle.addEventListener('pointerup', onUp);
    });
  }

  dom.sidebarScrim.addEventListener('click', () => setSidebarOpen(false));

  // Sidebar ≡ hamburger — mirrors the header overflow pattern. Hosts
  // secondary project actions (currently just "+ Group") so the primary
  // "+ New project" button gets the full action-row width.
  const sidebarOverflowCtl = makeDismissable({
    isInside: (t) => dom.sidebarOverflowPanel.contains(t) || dom.sidebarOverflowToggle.contains(t),
    onDismiss: () => closeSidebarOverflow(),
  });
  function closeSidebarOverflow() {
    if (!sidebarOverflowCtl.armed) return;
    dom.sidebarOverflowPanel.hidden = true;
    dom.sidebarOverflowToggle.setAttribute('aria-expanded', 'false');
    sidebarOverflowCtl.disarm();
  }
  function toggleSidebarOverflow() {
    if (sidebarOverflowCtl.armed) { closeSidebarOverflow(); return; }
    dom.sidebarOverflowPanel.hidden = false;
    dom.sidebarOverflowToggle.setAttribute('aria-expanded', 'true');
    sidebarOverflowCtl.arm();
  }
  dom.sidebarOverflowToggle.addEventListener('click', toggleSidebarOverflow);

  return { setSidebarOpen, closeSidebarOnMobile, closeSidebarOverflow };
}
