// Workaround for installed-PWA link handling on Android.
//
// In a `display: standalone` PWA, Chrome on Android routes `<a target="_blank">`
// (and `window.open(url, '_blank')`) into a Chrome Custom Tab attached to the
// PWA's own task. The CCT looks like part of the app, and on memory-constrained
// devices Android often reaps the PWA task while the CCT is foreground — so
// dismissing the website also kills the PWA.
//
// On Android we sidestep CCT entirely by handing the URL off as an `intent://`
// system intent. Chrome resolves the intent and opens the URL in a normal
// browser tab in a *separate* task, so the PWA stays alive in the background
// and the user can return to it via the app switcher.
//
// On non-Android standalone clients (e.g. desktop PWA) we fall back to an
// explicit `window.open(url, '_blank', 'noopener,noreferrer')` from the user
// gesture, which already opens a real new browser window there.

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const INTENT_SCHEMES = new Set(['http:', 'https:']);

function isStandalone(win) {
  try {
    return !!(win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);
  } catch {
    return false;
  }
}

function isAndroid(win) {
  try {
    return /Android/i.test(win.navigator && win.navigator.userAgent || '');
  } catch {
    return false;
  }
}

function isModifierClick(e) {
  return e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || (e.button != null && e.button !== 0);
}

// Encode an http(s) URL as an Android intent: URI. Chrome treats navigations
// to `intent://...` specially — it dispatches a VIEW intent for the embedded
// URL and stays on the current page, so the PWA itself does not navigate.
export function toIntentUrl(url) {
  const scheme = url.protocol.replace(/:$/, '');
  const rest = (url.host || '') + (url.pathname || '') + (url.search || '') + (url.hash || '');
  // Include a browser_fallback_url so devices without a matching browser
  // intent handler don't end up on an error page.
  const fallback = encodeURIComponent(url.href);
  return `intent://${rest}#Intent;scheme=${scheme};S.browser_fallback_url=${fallback};end`;
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
    if (isAndroid(win) && INTENT_SCHEMES.has(url.protocol)) {
      win.location.href = toIntentUrl(url);
      return;
    }
    const opened = win.open(url.href, '_blank', 'noopener,noreferrer');
    if (!opened) {
      win.location.href = url.href;
    }
  });
}
