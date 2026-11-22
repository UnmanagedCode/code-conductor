import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { proxiedPluginHeaders } from '../securityHeaders.ts';

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

// The plugin-host subset this proxy consumes. Defined locally because proxy
// converts before src/plugins/registry.ts (which returns the real host);
// registry's host type must satisfy it at the composition root (server.ts).
export interface PluginHostProxyLike {
  ensureStarted(id: string): Promise<void>;
  // `port` is null only when no child record exists yet — every call site here
  // runs after ensureStarted() resolved, so the null branch is defensive.
  runtimeInfo(id: string): { status: string; port: number | null };
  reportUpstreamFailure(id: string): void;
}

const ID_PART_RE = /^\/([a-z][a-z0-9-]*)(\/.*)?$/;

// Reconstruct the raw header block from req.rawHeaders (name/value pairs),
// preserving order and casing (matters for Sec-WebSocket-* on upgrades).
function rawHeaderLines(rawHeaders: string[]): string {
  let out = '';
  for (let i = 0; i < rawHeaders.length; i += 2) {
    out += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  }
  return out;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// The two host URLs a plugin page may reference root-absolute: its bridge and
// the host theme. Under a base path, every byte sequence shaped like
// `src="/pluginBridge.js"` or `href='/pluginTheme.css'` (either quote) is
// re-rooted at the base. The match is by bytes, not markup: the same sequence in
// text or a script string is rewritten too, and nothing else is touched. Both
// targets are ASCII, so the body is read as latin1 (one char per byte) and every
// other byte, whatever the page's charset, comes through identical.
export function rewritePluginHostUrls(html: Buffer, base: string): Buffer {
  if (base === '') return html;
  return Buffer.from(html.toString('latin1').replace(/(\b(?:src|href)\s*=\s*)(["'])\/(pluginBridge\.js|pluginTheme\.css)\2/gi,
    (_m, attr: string, q: string, file: string) => `${attr}${q}${base}/${file}${q}`), 'latin1');
}

// The most HTML body the proxy buffers to rewrite; beyond it the page streams untouched.
export const REWRITE_BODY_CAP_BYTES = 4 * 1024 * 1024;

export function buildPluginProxy({ pluginHost, basePath = '' }: { pluginHost: PluginHostProxyLike | null; basePath?: string }) {
  // `<plugin id>:<reason>` already warned about: each degradation is logged once per plugin.
  const warned = new Set<string>();
  const warnOnce = (id: string, reason: 'encoded' | 'oversize', text: string) => {
    if (warned.has(`${id}:${reason}`)) return;
    warned.add(`${id}:${reason}`);
    console.warn(`plugin '${id}': ${text}; host URLs are not rewritten`);
  };

  async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!pluginHost) return jsonResponse(res, 404, { error: 'plugins are not available' });
    const u = new URL(req.url ?? '', 'http://placeholder');
    const m = ID_PART_RE.exec(u.pathname);
    if (!m) return jsonResponse(res, 404, { error: 'no plugin id in path' });
    const [, id, subpath] = m;

    // Bare /plugins/<id> → /plugins/<id>/ so the child's relative asset
    // URLs resolve under its prefix.
    if (subpath === undefined) {
      res.writeHead(301, { location: `${basePath}/plugins/${id}/${u.search}` });
      res.end();
      return;
    }

    try {
      await pluginHost.ensureStarted(id);
    } catch (e) {
      const err = e as { statusCode?: unknown; status?: unknown; tail?: unknown; retryAfter?: unknown; message?: unknown };
      return jsonResponse(res, typeof err.statusCode === 'number' ? err.statusCode : 500, {
        error: String(err.message ?? ''),
        ...(err.status !== undefined ? { status: err.status } : {}),
        ...(err.tail !== undefined ? { tail: err.tail } : {}),
        ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
      });
    }
    const { port } = pluginHost.runtimeInfo(id);
    // Post-ensureStarted the child has a port; null means it vanished in the
    // gap — fail closed rather than forward to a default/null port.
    if (port == null) return jsonResponse(res, 503, { error: `plugin '${id}' has no running backend` });

    const up = http.request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: subpath + u.search,
      headers: {
        ...req.headers,
        // Under a base the HTML is rewritten, so ask for it uncompressed (a
        // loopback hop gains nothing from compression); the outer proxy can
        // still compress toward the browser.
        ...(basePath !== '' ? { 'accept-encoding': 'identity' } : {}),
        'x-forwarded-prefix': `${basePath}/plugins/${id}`,
        'x-forwarded-host': req.headers.host ?? '',
        'x-forwarded-proto': 'http',
        'x-forwarded-for': req.socket.remoteAddress ?? '',
      },
    }, (upRes) => {
      // cc's own security headers are dropped and a framing default added
      // (proxiedPluginHeaders); the plugin's CSP and MIME types stay its own.
      const headers = proxiedPluginHeaders(res, upRes.headers);
      // Root-relative redirects from the child point back into its prefix.
      if (typeof headers.location === 'string' && headers.location.startsWith('/')) {
        headers.location = `${basePath}/plugins/${id}${headers.location}`;
      }
      // An upstream that aborts mid-body must end the client's response too, whichever branch carries it.
      upRes.on('error', () => res.destroy());
      const status = upRes.statusCode || 502;
      const isHtml = /^text\/html\b/i.test(String(upRes.headers['content-type'] ?? ''));
      const hasBody = req.method !== 'HEAD' && status !== 204 && status !== 304 && status !== 206 && status >= 200
        && upRes.headers['content-range'] === undefined;
      if (basePath !== '' && isHtml && hasBody) {
        const encoding = String(upRes.headers['content-encoding'] ?? 'identity').toLowerCase();
        const declared = Number(upRes.headers['content-length']);
        if (encoding !== 'identity') {
          warnOnce(id, 'encoded', `HTML answered with content-encoding ${encoding} under a base path`);
        } else if (declared > REWRITE_BODY_CAP_BYTES) {
          warnOnce(id, 'oversize', `HTML of ${declared} bytes exceeds the ${REWRITE_BODY_CAP_BYTES}-byte rewrite cap`);
        } else {
          const chunks: Buffer[] = [];
          let size = 0;
          const onData = (c: Buffer) => {
            chunks.push(c);
            size += c.length;
            if (size <= REWRITE_BODY_CAP_BYTES) return;
            // Over the cap with no declared length: stop buffering, send what is held, stream the rest.
            upRes.off('data', onData);
            upRes.off('end', onEnd);
            warnOnce(id, 'oversize', `HTML exceeds the ${REWRITE_BODY_CAP_BYTES}-byte rewrite cap`);
            res.writeHead(status, headers);
            res.write(Buffer.concat(chunks));
            upRes.pipe(res);
          };
          const onEnd = () => {
            const body = rewritePluginHostUrls(Buffer.concat(chunks), basePath);
            headers['content-length'] = String(body.length);
            delete headers['transfer-encoding'];
            res.writeHead(status, headers);
            res.end(body);
          };
          upRes.on('data', onData);
          upRes.on('end', onEnd);
          return;
        }
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

  async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const fail = (status: number, text: string) => {
      try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ }
      socket.destroy();
    };
    if (!pluginHost) return fail(404, 'Not Found');
    const u = new URL(req.url ?? '', 'http://placeholder');
    const m = /^\/plugins\/([a-z][a-z0-9-]*)(\/.*)$/.exec(u.pathname);
    if (!m) return fail(404, 'Not Found');
    const [, id, subpath] = m;

    try {
      await pluginHost.ensureStarted(id);
    } catch {
      return fail(503, 'Service Unavailable');
    }
    const { port } = pluginHost.runtimeInfo(id);
    if (port == null) return fail(503, 'Service Unavailable');

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
