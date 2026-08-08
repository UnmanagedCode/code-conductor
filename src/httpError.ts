// The statusCode-bearing Error the REST and MCP surfaces consume.
//
// `err.statusCode` is what the express error handler (routes.ts) reads to pick
// a response code, and what `codeForStatus` (mcp/server.ts) maps to a JSON-RPC
// code. `extra` merges arbitrary fields onto the error for handlers that render
// more than a message — the plugin routes attach `{ status, tail, retryAfter }`
// so a 503 body can explain a crashed/backed-off child.
//
// One home for the construction; every module that needs it imports from here
// rather than declaring its own copy.
export function httpError(
  statusCode: number,
  message: string,
  extra: Record<string, unknown> = {},
): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode }, extra);
}
