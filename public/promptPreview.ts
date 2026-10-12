// A session's first prompt as its label shows it. A prompt the server wrote — a
// wake-callback stub, a `send_prompt({forward})` frame, a `renew_session` seed —
// is rendered by name rather than by its raw marker or frame text; a person's
// prompt is the text as is. Shared by both UIs' sidebars and the web UI's
// other session labels.
//
// DOM-free, so the server could import it too.

import { parseWakeCallback } from './wakeCallback.ts';
import { FORWARD_FRAME_HEADER } from './forwardFrame.ts';
import { RENEW_SEED_PREAMBLE } from './renewSeed.ts';

// The server stores only a first prompt's head, which ends inside the forward
// header and the renew preamble, so the full-text parsers never match it; the
// header's first line and the preamble's first sentence identify them.
const FORWARD_LEAD = FORWARD_FRAME_HEADER.slice(0, FORWARD_FRAME_HEADER.indexOf('\n'));
const RENEW_LEAD = RENEW_SEED_PREAMBLE.slice(0, RENEW_SEED_PREAMBLE.indexOf('. ') + 1);

// The first prompt with a server-written one replaced by its name; '' for none.
export function readablePrompt(firstPrompt: unknown): string {
  const text = typeof firstPrompt === 'string' ? firstPrompt : '';
  const wake = parseWakeCallback(text);
  if (wake) return `Wake: ${wake.summary}`;
  if (text.startsWith(FORWARD_LEAD)) return 'Forwarded worker output';
  if (text.startsWith(RENEW_LEAD)) return 'Context renewed';
  return text;
}

// The sidebar's one-line preview: the readable prompt's first 80 chars,
// whitespace collapsed.
export function promptPreview(firstPrompt: unknown): string {
  return readablePrompt(firstPrompt).slice(0, 80).replace(/\s+/g, ' ').trim();
}
