// A session's first prompt as its label shows it. A prompt the server or the
// CLI wrote — a wake-callback stub, a `send_prompt({forward})` frame, a
// `renew_session` seed, a local command's head records — is rendered by name
// rather than by its raw marker, frame or tag text; a person's prompt is the
// text as is. Shared by both UIs' sidebars, the web UI's
// other session labels and the MCP list_sessions / describe_session rows.
//
// DOM-free: the server imports it too.

import { parseWakeCallback } from './wakeCallback.ts';
import { FORWARD_FRAME_HEADER } from './forwardFrame.ts';
import { RENEW_SEED_PREAMBLE } from './renewSeed.ts';

// The server stores only a first prompt's head, which ends inside the forward
// header and the renew preamble, so the full-text parsers never match it; the
// header's first line and the preamble's first sentence identify them.
const FORWARD_LEAD = leadOf(FORWARD_FRAME_HEADER, 'FORWARD_FRAME_HEADER', '\n', 0);
const RENEW_LEAD = leadOf(RENEW_SEED_PREAMBLE, 'RENEW_SEED_PREAMBLE', '. ', 1);

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

// The first prompt with a machine-written one replaced by its name; '' for none.
export function readablePrompt(firstPrompt: unknown): string {
  const text = typeof firstPrompt === 'string' ? firstPrompt : '';
  const wake = parseWakeCallback(text);
  if (wake) return `Wake: ${wake.summary}`;
  if (text.startsWith(FORWARD_LEAD)) return 'Forwarded worker output';
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
