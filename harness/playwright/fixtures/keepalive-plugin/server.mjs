// Backend of the keep-alive probe plugin (harness/playwright/check-plugin-keepalive.mjs).
// node:http only: serves the probe page, /health, and a WebSocket at /ws that
// pushes a text frame every TICK_MS so the page can count what it received.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const TICK_MS = 200;
const PAGE = readFileSync(new URL('./index.html', import.meta.url));

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404);
  res.end();
});

// Server → client text frames only; anything the client sends is ignored
// except a close frame.
server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let n = 0;
  const timer = setInterval(() => {
    const payload = Buffer.from(String(++n));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  }, TICK_MS);
  const stop = () => clearInterval(timer);
  socket.on('data', (buf) => { if ((buf[0] & 0x0f) === 0x8) { stop(); socket.end(); } });
  socket.on('close', stop);
  socket.on('error', stop);
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1');
