// Workaround for installed-PWA link handling on Android.
//
// In a `display: standalone` PWA, Chrome on Android routes `<a target="_blank">`
// navigations back into the same standalone window — the URL replaces the app
// view, and tapping the system close affordance kills the whole PWA instead of
// just the website. Calling `window.open(href, '_blank', ...)` explicitly from
// a user-gesture click handler bypasses this and spawns a real Chrome tab in a
// separate task, so dismissing it returns to the app switcher and the PWA
// stays alive in the background.

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function isStandalone(win) {
  try {
    return !!(win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);
  } catch {
    return false;
  }
}

function isModifierClick(e) {
  return e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || (e.button != null && e.button !== 0);
}

export function installExternalLinkOpener({ doc = document, win = window } = {}) {
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    if (isModifierClick(e)) return;
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    if (a.getAttribute('target') !== '_blank') return;
    const href = a.getAttribute('href');
    if (!href) return;
    let url;
    try {
      url = new URL(href, doc.baseURI || win.location.href);
    } catch {
      return;
    }
    if (!SAFE_SCHEMES.has(url.protocol)) return;
    if (!isStandalone(win)) return;
    e.preventDefault();
    const opened = win.open(url.href, '_blank', 'noopener,noreferrer');
    if (!opened) {
      win.location.href = url.href;
    }
  });
}
