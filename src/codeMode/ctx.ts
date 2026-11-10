// The slice of the per-request tool context code mode reads. The MCP server
// fills it (src/mcp/server.ts); `McpCtx` and the registry's `ToolCtx` extend it.

import type { RunRegistry } from './runs.ts';
import type { CallerKind } from '../plugins/toolAudience.ts';

// The part of a registered tool code mode lists and signs.
export interface ToolView {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

export interface ProgressTiming { heartbeatMs: number; minIntervalMs: number }

export interface CodeModeCtx {
  // Set when the call arrived from a run_code child (a valid run token).
  run?: { callerId: string } | null;
  // The CLI's id for this call (`params._meta["claudecode/toolUseId"]` on a
  // JSON-RPC tools/call; src/toolResultNudges.ts), or null when the call
  // carried none — every REST-alias call included.
  toolUseId?: string | null;
  runs?: RunRegistry;
  // Writes a progress notification to the call's stream, opening it on first
  // use. A no-op when the client did not ask for a stream.
  progress?: (progress: number, message: string) => void;
  // Aborts when the client cancels the call or its connection closes.
  signal?: AbortSignal;
  // `<origin>/mcp`, on the interface this request arrived on.
  selfUrl?: string;
  codeModeTiming?: ProgressTiming;
  // The live composition this request sees, and the plugin tools this format
  // cannot serve.
  tools?: readonly ToolView[];
  textOnlyTools?: ReadonlyMap<string, ToolView>;
  // Plugin tools left out because the caller is outside their audience (only
  // the keys are read), and the caller's kind.
  barredTools?: ReadonlyMap<string, unknown>;
  callerKind?: CallerKind;
}
