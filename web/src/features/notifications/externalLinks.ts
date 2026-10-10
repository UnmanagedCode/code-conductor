// Installed-PWA link handling on Android. In a standalone PWA, Chrome routes
// `target="_blank"` links into a Custom Tab attached to the PWA's own task,
// which Android may reap along with the app. Hand them to Chrome proper via an
// intent:// URL instead, after stashing the session anchor so a cold relaunch
// lands back on the same session. Outside standalone mode nothing changes.
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const INTENT_SCHEMES = new Set(['http:', 'https:']);

function isStandalone(win: Window) {
  try { return !!win.matchMedia?.('(display-mode: standalone)').matches; } catch { return false; }
}

function isAndroid(win: Window) {
  try { return /Android/i.test(win.navigator?.userAgent || ''); } catch { return false; }
}

function isModifierClick(e: MouseEvent) {
  return e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || (e.button != null && e.button !== 0);
}

export function toIntentUrl(url: URL) {
  const scheme = url.protocol.replace(/:$/, '');
  const rest = (url.host || '') + (url.pathname || '') + (url.search || '') + (url.hash || '');
  return `intent://${rest}#Intent;scheme=${scheme};package=com.android.chrome;end`;
}

export function installExternalLinkOpener({ doc = document, win = window, beforeNavigate }: { doc?: Document; win?: Window; beforeNavigate?: (url: URL) => void } = {}) {
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented || isModifierClick(e)) return;
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a || a.getAttribute('target') !== '_blank') return;
    const href = a.getAttribute('href');
    if (!href) return;
    let url: URL;
    try { url = new URL(href, doc.baseURI || win.location.href); } catch { return; }
    if (!SAFE_SCHEMES.has(url.protocol) || !isStandalone(win)) return;
    e.preventDefault();
    try { beforeNavigate?.(url); } catch { /* a hook must not abort the click */ }
    if (isAndroid(win) && INTENT_SCHEMES.has(url.protocol)) {
      win.location.href = toIntentUrl(url);
      return;
    }
    const opened = win.open(url.href, '_blank', 'noopener,noreferrer');
    if (!opened) win.location.href = url.href;
  });
}
