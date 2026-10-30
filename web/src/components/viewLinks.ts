// The app's policy for links to cc in rendered markdown (shared/markdown.ts emits each link as a new-tab anchor):
// `http://cc.internal/#<view>`, cc's own page, or a bare `#…`.
import type * as React from 'react';
import { isCcLinkHost, openView, viewLinkHash } from '@/state/route';
import { showLinkInDock } from '@/features/views/dock';

/** A link only cc acts on: a bare `#…`, or any link on the cc.internal host. */
const ccOwned = (href: string) => href.startsWith('#') || isCcLinkHost(href);

/**
 * A link to cc naming a view becomes a same-tab link to its in-app hash, so a middle-click opens cc at that view. Any
 * other link cc owns becomes literal text: an autolink (text equal to its href) its bare URL, any other the renderer's
 * `[label](href)`. Every other link is left as it is.
 */
export function adoptViewLinks(root: HTMLElement) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    const hash = viewLinkHash(href);
    if (hash) {
      a.setAttribute('href', hash);
      a.removeAttribute('target');
      a.removeAttribute('rel');
    } else if (ccOwned(href)) {
      a.replaceWith(a.textContent === href ? href : `[${a.textContent}](${href})`);
    }
  }
}

/** A plain click on a view link opens the view in-app (a plugin link in the dock while it shows a plugin beside the session); a modified or non-primary click stays the browser's. */
export function followViewLink(e: React.MouseEvent<HTMLElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element).closest('a');
  if (!a || !e.currentTarget.contains(a)) return;
  const hash = viewLinkHash(a.getAttribute('href') ?? '');
  if (!hash) return;
  e.preventDefault();
  if (!showLinkInDock(hash)) openView(hash);
}
