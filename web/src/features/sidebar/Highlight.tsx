import * as React from 'react';
import { highlightRanges } from './textFilter';

/** `text` with every occurrence of the filter's tokens marked; plain text when there are none. */
export function Highlight({ text, tokens }: { text: string; tokens?: string[] }) {
  const ranges = tokens && tokens.length > 0 ? highlightRanges(text, tokens) : [];
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start} data-match className="rounded-sm bg-warning/30 text-inherit">{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
