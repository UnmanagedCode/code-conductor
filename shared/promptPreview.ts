// A session's first prompt as it is stored and as its label shows it. A prompt
// the server or the CLI wrote — a wake-callback stub, a `send_prompt({forward})`
// frame, a `renew_session` seed, a local command's head records — is rendered
// by name (a forward by its instruction's first line) rather than by its raw
// marker, frame or tag text; a person's prompt is the text as is. Also the
// session label built on it (sessionLabel). Shared by the server's two
// first-prompt capture points (`Instance.prompt`, `readFirstPrompt`), the
// server's `displayLabel` on GET /api/instances, the web UI's session labels
// (sidebar, session panels, Settings → Archived) and the MCP list_sessions /
// describe_session rows.
//
// DOM-free: the server imports it too.

import { parseWakeCallback } from './wakeCallback.ts';
import { FORWARD_FRAME_FOOTER, FORWARD_FRAME_HEADER, parseForwardFrame } from './forwardFrame.ts';
import { RENEW_SEED_PREAMBLE } from './renewSeed.ts';

// The length of the head the server stores of a first prompt.
export const FIRST_PROMPT_CAP = 200;

// The stored head ends inside the renew preamble, so the full-text parser never
// matches it; the preamble's first sentence identifies it. A forward is stored
// as its tail (FORWARD_TAIL, below); the header's first line catches a head cut
// inside the header — a value stored before the tail was kept, or a frame with
// no END paragraph.
const FORWARD_LEAD = leadOf(FORWARD_FRAME_HEADER, 'FORWARD_FRAME_HEADER', '\n', 0);
const RENEW_LEAD = leadOf(RENEW_SEED_PREAMBLE, 'RENEW_SEED_PREAMBLE', '. ', 1);
const FORWARD_TAIL = FORWARD_FRAME_FOOTER + '\n\n';
const FORWARD_NAME = 'Forwarded worker output';

// The CLI's head records for a local slash command: an isMeta caveat line, then
// the `<command-name>` line. A session file opens with them after
// renew_session's `/clear`, the only local command cc starts a file with, and
// the server's first prompt is whichever comes first. The caveat names no
// command, so it reads as that renewal.
const LOCAL_COMMAND_CAVEAT = '<local-command-caveat>';
const COMMAND_NAME = /^<command-name>([^<]*)<\/command-name>/;

// `text` up to its first `end` (keeping `keep` chars of it). A lead must be
// non-empty: '' would match every prompt, so a constant without `end` fails
// the module's load.
function leadOf(text: string, name: string, end: string, keep: number): string {
  const i = text.indexOf(end);
  if (i <= 0) throw new Error(`promptPreview: ${name} has no ${JSON.stringify(end)} to cut its lead at`);
  return text.slice(0, i + keep);
}

// The head of a first prompt the server stores. A forward keeps its frame's
// tail (the END marker plus the conductor's instruction) because the
// instruction sits past any head cut.
export function firstPromptHead(text: string): string {
  const fwd = parseForwardFrame(text);
  return (fwd ? FORWARD_TAIL + fwd.instruction.trimStart() : text).slice(0, FIRST_PROMPT_CAP);
}

// The first line of `text` with non-whitespace content, trimmed; '' for none.
function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim())?.trim() ?? '';
}

// The first prompt with a machine-written one replaced by its name; '' for none.
export function readablePrompt(firstPrompt: unknown): string {
  const text = typeof firstPrompt === 'string' ? firstPrompt : '';
  const wake = parseWakeCallback(text);
  if (wake) return `Wake: ${wake.summary}`;
  if (text.startsWith(FORWARD_TAIL)) return firstLine(text.slice(FORWARD_TAIL.length)) || FORWARD_NAME;
  if (text.startsWith(FORWARD_LEAD)) return FORWARD_NAME;
  if (text.startsWith(RENEW_LEAD) || text.startsWith(LOCAL_COMMAND_CAVEAT)) return 'Context renewed';
  const command = COMMAND_NAME.exec(text);
  if (command) return command[1] === '/clear' ? 'Context renewed' : command[1];
  return text;
}

// The sidebar's one-line preview: the readable prompt's first 80 chars,
// whitespace collapsed.
export function promptPreview(firstPrompt: unknown): string {
  return readablePrompt(firstPrompt).slice(0, 80).replace(/\s+/g, ' ').trim();
}

// A session's label (the sidebar row's, and GET /api/instances' displayLabel):
// custom title → promptPreview → '(new session)' for a live row not on disk yet
// → the sessionId prefix.
export function sessionLabel(s: { sessionId: string | null; title?: string | null; firstPrompt?: unknown; synthetic?: boolean }): string {
  const title = (s.title ?? '').trim();
  const preview = promptPreview(s.firstPrompt);
  return title || preview || (s.synthetic ? '(new session)' : `${String(s.sessionId).slice(0, 8)}…`);
}
