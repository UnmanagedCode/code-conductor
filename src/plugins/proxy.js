import http from 'node:http';
import net from 'node:net';

// Same-origin reverse proxy for plugin backends — `/plugins/<id>/*` → the
// child's `/*`. Hand-rolled on node:http/node:net (code-hub authproxy
// pattern): bodies are never parsed, requests stream straight through
// (SSE included), and WebSocket upgrades are piped as raw sockets with the
// original header order/casing replayed.
//
// buildPluginProxy returns:
//   handler(req, res)             — express-mounted at /plugins (prefix
//                                   already stripped: req.url = '/<id>/…')
//   handleUpgrade(req, socket, head) — raw dispatch from server.on('upgrade')
//                                   (full URL: '/plugins/<id>/…')

const ID_PART_RE = /^\/([a-z][a-z0-9-]*)(\/.*)?$/;

// Reconstruct the raw header block from req.rawHeaders (name/value pairs),
// preserving order and casing (matters for Sec-WebSocket-* on upgrades).
function rawHeaderLines(rawHeaders) {
  let out = '';
  for (let i = 0; i < rawHeaders.length; i += 2) {
    out += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  }
  return out;
}

function jsonResponse(res, status, body) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function buildPluginProxy({ pluginHost }) {
  async function handler(req, res) {
    if (!pluginHost) return jsonResponse(res, 404, { error: 'plugins are not available' });
    const u = new URL(req.url, 'http://placeholder');
    const m = ID_PART_RE.exec(u.pathname);
    if (!m) return jsonResponse(res, 404, { error: 'no plugin id in path' });
    const [, id, subpath] = m;

    // Bare /plugins/<id> → /plugins/<id>/ so the child's relative asset
    // URLs resolve under its prefix.
    if (subpath === undefined) {
      res.writeHead(301, { location: `/plugins/${id}/${u.search}` });
      res.end();
      return;
    }

    try {
      await pluginHost.ensureStarted(id);
    } catch (e) {
      return jsonResponse(res, e.statusCode ?? 500, {
        error: e.message,
        ...(e.status ? { status: e.status } : {}),
        ...(e.tail ? { tail: e.tail } : {}),
        ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
      });
    }
    const { port } = pluginHost.runtimeInfo(id);

    const up = http.request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: subpath + u.search,
      headers: {
        ...req.headers,
        'x-forwarded-prefix': `/plugins/${id}`,
        'x-forwarded-host': req.headers.host ?? '',
        'x-forwarded-proto': 'http',
        'x-forwarded-for': req.socket.remoteAddress ?? '',
      },
    }, (upRes) => {
      const headers = { ...upRes.headers };
      // Root-relative redirects from the child point back into its prefix —
      // the only header rewrite in v1.
      if (typeof headers.location === 'string' && headers.location.startsWith('/')) {
        headers.location = `/plugins/${id}${headers.location}`;
      }
      res.writeHead(upRes.statusCode || 502, headers);
      upRes.pipe(res);
    });
    up.on('error', (e) => {
      pluginHost.reportUpstreamFailure(id);
      jsonResponse(res, 502, { error: `plugin upstream error: ${e.message}` });
    });
    req.pipe(up);
  }

  async function handleUpgrade(req, socket, head) {
    const fail = (status, text) => {
      try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ }
      socket.destroy();
    };
    if (!pluginHost) return fail(404, 'Not Found');
    const u = new URL(req.url, 'http://placeholder');
    const m = /^\/plugins\/([a-z][a-z0-9-]*)(\/.*)$/.exec(u.pathname);
    if (!m) return fail(404, 'Not Found');
    const [, id, subpath] = m;

    try {
      await pluginHost.ensureStarted(id);
    } catch {
      return fail(503, 'Service Unavailable');
    }
    const { port } = pluginHost.runtimeInfo(id);

    const up = net.connect(port, '127.0.0.1', () => {
      // Replay the handshake with a rewritten request line; rawHeaders keeps
      // the original order/casing (Sec-WebSocket-* et al).
      up.write(`${req.method} ${subpath + u.search} HTTP/1.1\r\n${rawHeaderLines(req.rawHeaders)}\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    // Tear the pair down together so neither side lingers.
    up.on('error', () => { pluginHost.reportUpstreamFailure(id); socket.destroy(); });
    socket.on('error', () => up.destroy());
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  }

  return { handler, handleUpgrade };
}
