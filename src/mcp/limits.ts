// Every cap an MCP result is cut at, per output format — the one home for them.
//
// `/mcp` serves two formats (docs/mcp-applications.md):
//   - `text` — the agent view: renderings and payload blocks fitted to one
//     Claude Code MCP result (MCP_RESULT_CHAR_BUDGET). Its caps are CONTEXT caps.
//   - `json` — the application view: `structuredContent` against each tool's
//     outputSchema. Context caps do not apply; only SAFETY ceilings do, and each
//     one flags what it cut (`truncated:true` and friends).
//
// A handler with a cap reads it from `ctx.limits`; a `null` limit means no cut.
// The caps that bound stored data or input (the express.json request limit,
// GIT_OUTPUT_LIMIT_BYTES, HOOK_OUTPUT_CAP, MAX_FILE_BYTES, the bash timeouts) are
// the same in both formats and stay in their own modules.

import { MCP_RESULT_CHAR_BUDGET, MCP_BODY_BUDGET } from './content.ts';
import { MSG_TEXT_CAP, TOOL_ARG_VALUE_CAP } from './messageReconstruction.ts';
import { HUMAN_PROMPT_QUOTE_MAX_CHARS, HUMAN_PROMPT_QUOTE_MAX_COUNT } from '../promptAuthor.ts';

export type McpFormat = 'json' | 'text';

export const MCP_FORMATS: readonly McpFormat[] = ['json', 'text'];

// JSON-format safety ceilings. Each is far above any context budget and exists
// only so one call cannot buffer an unbounded body into one response.
export const JSON_READ_BODY_CAP = 8 * 1024 * 1024;
export const JSON_BASH_OUTPUT_CAP = 8 * 1024 * 1024;
export const JSON_DIFF_PAGE_BYTES = 8 * 1024 * 1024;
// Per echoed string in a refusal or an error (a tool name, a path, a reason).
export const JSON_ECHO_CAP = 64 * 1024;

export interface FormatLimits {
  // The most text one result may carry: get_transcript's page fit,
  // project_diff's page fit, get_recent_messages' fit ladder and the
  // RESULT_OVER_BUDGET backstop. null in JSON: none of those run.
  resultBudget: number | null;
  // project_read's `maxBytes` schema maximum and default.
  readBody: number;
  // Retained project_bash / system_bash output (the exec head cap and the re-cut).
  bashOutput: number;
  // project_diff's page ceiling in bytes when no result budget fits it.
  diffPageBytes: number | null;
  // project_diff's side lists (untracked, includedFiles, omittedFiles,
  // uncommitted.files), in chars of JSON.
  diffSideListChars: number | null;
  // project_status's `dirty` list.
  dirtyCap: number | null;
  // playbook_state's `history`.
  historyCap: number | null;
  // get_recent_messages' per-message prose / narration / block cap.
  msgTextCap: number | null;
  // The default (descriptor) rendering of a tool_use input's arguments.
  toolArgValueCap: number | null;
  // The send-time `humanPrompts` field's quote cut.
  humanPromptQuote: { maxChars: number; maxCount: number } | null;
  // Per echoed string in a refusal or an error.
  echoCap: number;
}

export const TEXT_LIMITS: FormatLimits = Object.freeze({
  resultBudget: MCP_RESULT_CHAR_BUDGET,
  readBody: MCP_BODY_BUDGET,
  bashOutput: MCP_BODY_BUDGET,
  diffPageBytes: null,
  diffSideListChars: MCP_RESULT_CHAR_BUDGET / 8,
  dirtyCap: 500,
  historyCap: 200,
  msgTextCap: MSG_TEXT_CAP,
  toolArgValueCap: TOOL_ARG_VALUE_CAP,
  humanPromptQuote: Object.freeze({ maxChars: HUMAN_PROMPT_QUOTE_MAX_CHARS, maxCount: HUMAN_PROMPT_QUOTE_MAX_COUNT }),
  echoCap: MCP_RESULT_CHAR_BUDGET / 8,
});

export const JSON_LIMITS: FormatLimits = Object.freeze({
  resultBudget: null,
  readBody: JSON_READ_BODY_CAP,
  bashOutput: JSON_BASH_OUTPUT_CAP,
  diffPageBytes: JSON_DIFF_PAGE_BYTES,
  diffSideListChars: null,
  dirtyCap: null,
  historyCap: null,
  msgTextCap: null,
  toolArgValueCap: null,
  humanPromptQuote: null,
  echoCap: JSON_ECHO_CAP,
});

export function limitsFor(format: McpFormat): FormatLimits {
  return format === 'json' ? JSON_LIMITS : TEXT_LIMITS;
}
