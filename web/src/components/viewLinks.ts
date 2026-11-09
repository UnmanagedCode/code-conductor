// The app's policy for links to cc in rendered markdown, applied by Markdown.tsx's `a` component as each link renders:
// `http://cc.internal/#<view>`, cc's own page, or a bare `#…`.
import type * as React from 'react';
import { isCcLinkHost, openView, viewLinkHash } from '@/state/route';
import { showLinkInDock } from '@/features/views/dock';

/** A link only cc acts on: a bare `#…`, or any link on the cc.internal host. */
const ccOwned = (href: string) => href.startsWith('#') || isCcLinkHost(href);

type LinkKind = { kind: 'view'; hash: string } | { kind: 'literal' } | { kind: 'external' };

/**
 * How a safe-scheme link renders: a link to cc naming a view is a same-tab link to its in-app hash, so a middle-click
 * opens cc at that view; any other link cc owns is literal text (its source); every other link is a new-tab anchor.
 */
export function classifyLink(href: string): LinkKind {
  const hash = viewLinkHash(href);
  if (hash) return { kind: 'view', hash };
  return ccOwned(href) ? { kind: 'literal' } : { kind: 'external' };
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
