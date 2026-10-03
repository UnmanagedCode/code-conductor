// Sends one prompt to a live instance over the WebSocket and exits on the ack.
// Usage: node w2-send.mjs <port> <instanceId> <text>
// The smoke script watches the result through GET /api/instances/:id/events.
import WebSocket from 'ws';

const [port, id, ...rest] = process.argv.slice(2);
const text = rest.join(' ');
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const timer = setTimeout(() => { console.error('no ack within 15s'); process.exit(2); }, 15000);
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'subscribe', id }));
  ws.send(JSON.stringify({ t: 'prompt', id, text, reqId: 'w2' }));
});
ws.on('message', (m) => {
  const f = JSON.parse(String(m));
  if (f.t === 'ack' && f.reqId === 'w2') {
    clearTimeout(timer);
    console.log(JSON.stringify(f));
    ws.close();
    process.exit(f.ok ? 0 : 1);
  }
});
ws.on('error', (e) => { console.error(e.message); process.exit(2); });
