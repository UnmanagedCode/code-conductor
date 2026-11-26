// The context chip's injected block: the one place its wire format is written
// and read, for the server (composing a send) and the web client (recognising a
// sent message in the transcript). DOM-free.
//
// A chip is recognised ONLY from CHIP_MARKER, which cc emits — a "Context:" line
// a user typed carries no marker and stays plain text.

export const CHIP_MARKER = '[[cc:context-chip]]';
const TITLE_PREFIX = `${CHIP_MARKER} Context: `;

export interface ChipContent { title: string; data: string }

// A fence one backtick longer than the longest run in `data` (at least three),
// so `data` can never close it.
function fenceFor(data: string): string {
  let longest = 0;
  for (const run of data.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function formatChipBlock({ title, data }: ChipContent): string {
  const body = data.endsWith('\n') ? data : `${data}\n`;
  const fence = fenceFor(data);
  return `${TITLE_PREFIX}${title}\n${fence}\n${body}${fence}`;
}

// The sent text: the block first, then a blank line and the typed text.
export function composeChipMessage(chip: ChipContent, typed: string): string {
  const block = formatChipBlock(chip);
  return typed ? `${block}\n\n${typed}` : block;
}

// The chip a message leads with, and the text after it; null for anything that
// is not exactly a block cc composed (no marker, an unterminated fence, text
// glued to the closing fence). `data` has the formatter's trailing newline removed.
export function parseLeadingChip(text: string): (ChipContent & { rest: string }) | null {
  if (!text.startsWith(TITLE_PREFIX)) return null;
  const titleEnd = text.indexOf('\n');
  if (titleEnd < 0) return null;
  const fenceEnd = text.indexOf('\n', titleEnd + 1);
  if (fenceEnd < 0) return null;
  const fence = text.slice(titleEnd + 1, fenceEnd);
  if (!/^`{3,}$/.test(fence)) return null;
  const closer = `\n${fence}`;
  let at = text.indexOf(closer, fenceEnd + 1);
  while (at >= 0) {
    const after = at + closer.length;
    if (after === text.length) {
      return { title: text.slice(TITLE_PREFIX.length, titleEnd), data: text.slice(fenceEnd + 1, at), rest: '' };
    }
    if (text.startsWith('\n\n', after)) {
      return { title: text.slice(TITLE_PREFIX.length, titleEnd), data: text.slice(fenceEnd + 1, at), rest: text.slice(after + 2) };
    }
    at = text.indexOf(closer, at + 1);
  }
  return null;
}
