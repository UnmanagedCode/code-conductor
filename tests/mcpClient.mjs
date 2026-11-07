// The /mcp URL contract in one place for tests: identity in the path
// (`/mcp/<sessionId>`), presentation in the query (`?format=`). See
// docs/mcp-applications.md.
export function mcpUrl(base, { caller = null, format = null, suffix = '' } = {}) {
  const pathPart = '/mcp' + (caller ? `/${encodeURIComponent(caller)}` : '') + suffix;
  return base + pathPart + (format ? `?format=${encodeURIComponent(format)}` : '');
}

// One JSON-RPC POST; returns {status, body}.
let nextId = 1;
export async function rpc(base, method, params, opts = {}) {
  const res = await fetch(mcpUrl(base, opts), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
