// Dependency-free fake plugin backend (node:http only) — the conductor
// plugin epic's acceptance fixture. Exercises every proxy/MCP surface:
// health, relative-asset HTML, streaming echo, redirect (Location rewrite),
// a 500 route (transport-failure mapping), a hand-rolled WS echo, an env
// dump, and the pinned child-MCP contract (HTTP 200 for every well-formed
// tool invocation with {result} or {error}; non-200 = transport failure).
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 0); // standalone-runnable: defaults its own (ephemeral) port

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, plugin: 'fake-plugin' }));
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><script src="/pluginBridge.js" defer></script></head>'
      + '<body><h1>fake plugin</h1><img src="asset.svg" alt="asset"></body></html>');
    return;
  }
  if (url.pathname === '/asset.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    return;
  }
  if (url.pathname === '/env') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      port: PORT,
      conductorUrl: process.env.CONDUCTOR_URL ?? null,
      pluginId: process.env.CONDUCTOR_PLUGIN_ID ?? null,
      query: url.search,
    }));
    return;
  }
  if (url.pathname === '/echo' && req.method === 'POST') {
    // Streaming echo: each request chunk is flushed back immediately.
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    req.on('data', (c) => res.write(c));
    req.on('end', () => res.end());
    return;
  }
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: '/somewhere' });
    res.end();
    return;
  }
  if (url.pathname === '/redirect-absolute') {
    res.writeHead(302, { location: 'https://example.com/elsewhere' });
    res.end();
    return;
  }
  if (url.pathname === '/boom') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'deliberate transport-level failure' }));
    return;
  }
  if (url.pathname === '/api/mcp' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); }
    catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed envelope' }));
      return;
    }
    const reply = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const args = body.arguments ?? {};
    if (body.tool === 'echo') {
      if (typeof args.message !== 'string') return reply({ error: 'echo: message (string) is required' });
      return reply({ result: { message: args.message, caller: body.caller ?? null } });
    }
    if (body.tool === 'sleep') {
      const ms = Number.isInteger(args.ms) ? args.ms : 0;
      setTimeout(() => reply({ result: { slept: ms } }), ms);
      return;
    }
    if (body.tool === 'transport-bug') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('deliberate 500 from the mcp endpoint');
      return;
    }
    // 'fail' (and anything undeclared) lands here: tool-level failure.
    return reply({ error: `unknown tool '${body.tool}'` });
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
});

// Hand-rolled WebSocket echo on /ws-echo — enough of RFC 6455 for small
// single-frame text messages, keeping the fixture dependency-free.
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws-echo') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (buf) => {
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    if (opcode === 0x8) { socket.end(); return; } // close frame
    if (opcode !== 0x1) return; // text frames only
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const masked = (buf[1] & 0x80) !== 0;
    let payload;
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    } else {
      payload = Buffer.from(buf.subarray(off, off + len));
    }
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    }
    socket.write(Buffer.concat([header, payload]));
  });
  socket.on('error', () => socket.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake-plugin listening on ${server.address().port}`);
});
