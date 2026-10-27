// The app's policy for `#` links in rendered markdown (shared/markdown.ts emits each as a new-tab anchor).
import type * as React from 'react';
import { openView, viewLinkHash } from '@/state/route';
import { showLinkInDock } from '@/features/views/dock';

/** A `#` link naming a cc view becomes a same-tab link; any other `#` link becomes the renderer's literal `[label](href)` text. */
export function adoptViewLinks(root: HTMLElement) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    const href = a.getAttribute('href') ?? '';
    if (viewLinkHash(href)) {
      a.removeAttribute('target');
      a.removeAttribute('rel');
    } else {
      a.replaceWith(`[${a.textContent}](${href})`);
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
