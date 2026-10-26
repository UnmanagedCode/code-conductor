import * as React from 'react';
import { renderMarkdownInto } from '@shared/markdown';
import { cn } from '@/lib/utils';
import { adoptViewLinks, followViewLink } from './viewLinks';

/**
 * Markdown through the app's safe renderer (shared/markdown.ts): text only
 * via textContent, links and images restricted to safe schemes. Styled by the
 * `.md` rules in index.css. `#` links follow the app's policy (viewLinks.ts): a cc view
 * opens in the same tab, any other renders as literal text.
 */
export const Markdown = React.memo(function Markdown({
  text, className, renderInto,
}: { text: string; className?: string; renderInto?: (el: HTMLElement, text: string) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.textContent = '';
    (renderInto ?? renderMarkdownInto)(ref.current, text);
    adoptViewLinks(ref.current);
  }, [text, renderInto]);
  return <div ref={ref} className={cn('md', className)} onClick={followViewLink} />;
});
