import * as React from 'react';
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element } from 'hast';
import { cn } from '@/lib/utils';
import { classifyLink, followViewLink } from './viewLinks';
import { safeUrl } from './markdown/safeUrl';
import { rehypeBlockWhitespace } from './markdown/rehypeBlockWhitespace';
import { rehypeInlineEnd } from './markdown/inlineEnd';
import { CodeBlock } from './markdown/CodeBlock';
import { listItem } from './markdown/listItem';
import { overBudget } from './markdown/complexity';

/** What a `<Markdown inlineEnd>` renders in the slot at the inline end of its last line of prose. */
export const MarkdownInlineEnd = React.createContext<React.ReactNode>(null);

// A single `~` stays literal: agents write it for "about".
const REMARK: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }]];
// Converts list items in linear time (markdown/listItem.ts).
const REMARK_REHYPE: Options['remarkRehypeOptions'] = { handlers: { listItem } };
const REHYPE: Options['rehypePlugins'] = [rehypeBlockWhitespace];
const REHYPE_INLINE_END: Options['rehypePlugins'] = [rehypeBlockWhitespace, rehypeInlineEnd];

function SpeakSlot() {
  return <span data-speak-slot="">{React.useContext(MarkdownInlineEnd)}</span>;
}

/** The component overrides for one source `text`: a refused or cc-owned link or a refused image renders as its own source. */
function components(text: string): Components {
  const literal = (node: Element | undefined, fallback: React.ReactNode) => {
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    return start != null && end != null ? text.slice(start, end) : <>{fallback}</>;
  };
  return {
    a: ({ node, href, children }) => {
      if (href == null) return literal(node, children);
      const link = classifyLink(href);
      if (link.kind === 'view') return <a href={link.hash}>{children}</a>;
      if (link.kind === 'literal') return literal(node, children);
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
    img: ({ node, src, alt }) => (src == null ? literal(node, alt) : <img src={src} alt={alt ?? ''} loading="lazy" />),
    pre: ({ node }) => <CodeBlock node={node} />,
    span: ({ node, children, ...rest }: React.ComponentProps<'span'> & ExtraProps) =>
      node?.properties.dataSpeakSlot !== undefined ? <SpeakSlot /> : <span {...rest}>{children}</span>,
  };
}

/** The fallback for markdown that cannot or must not render: its raw source in one bare <pre>. */
function RawSource({ text }: { text: string }) {
  return <pre>{text}</pre>;
}

/** Shows the raw source when rendering `text` throws; a new `text` tries again. */
class MarkdownBoundary extends React.Component<{ text: string; children: React.ReactNode }, { text: string; failed: boolean }> {
  state = { text: this.props.text, failed: false };
  static getDerivedStateFromProps(props: { text: string }, state: { text: string }) {
    return props.text === state.text ? null : { text: props.text, failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <RawSource text={this.props.text} /> : this.props.children;
  }
}

/**
 * Markdown (CommonMark + GFM) through react-markdown: raw HTML shows as its literal source, links and images pass the
 * scheme allow-lists in markdown/safeUrl.ts, and a code block at any depth carries a Copy button. Styled by the `.md`
 * rules in index.css. Links to cc (`http://cc.internal/#…`, cc's own page) follow the app's policy (viewLinks.ts): a cc
 * view opens in the same tab, any other renders as literal text. `inlineEnd` adds a slot at the inline end of the last
 * line of prose holding the nearest MarkdownInlineEnd value. Never throws: a failed render shows the raw source, as does
 * a document past the complexity budget (COMPLEXITY_LIMITS in markdown/complexity.ts), which is never parsed.
 */
export const Markdown = React.memo(function Markdown({
  text, className, inlineEnd = false,
}: { text: string; className?: string; inlineEnd?: boolean }) {
  const overrides = React.useMemo(() => components(text), [text]);
  const tooComplex = React.useMemo(() => overBudget(text), [text]);
  return (
    <div className={cn('md', className)} onClick={followViewLink}>
      {tooComplex ? <RawSource text={text} /> : (
        <MarkdownBoundary text={text}>
          <ReactMarkdown remarkPlugins={REMARK} remarkRehypeOptions={REMARK_REHYPE} rehypePlugins={inlineEnd ? REHYPE_INLINE_END : REHYPE} urlTransform={safeUrl} components={overrides}>
            {text}
          </ReactMarkdown>
        </MarkdownBoundary>
      )}
    </div>
  );
});
