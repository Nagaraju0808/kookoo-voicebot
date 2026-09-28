// Mimics KooKoo: connect to /ws, send a `start` event, count greeting media frames.
// Usage: node scripts/wss-test.mjs [wsUrl]
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const url = process.argv[2] || 'ws://127.0.0.1:3000/ws';
console.log(`connecting to ${url} ...`);

const ws = new WebSocket(url, { handshakeTimeout: 15000 });
let mediaFrames = 0;
let other = 0;

const timer = setTimeout(() => {
  console.log(`TIMEOUT after 20s: mediaFrames=${mediaFrames} other=${other}`);
  process.exit(2);
}, 20000);

ws.on('open', () => {
  console.log('WS OPEN — sending start event');
  ws.send(
    JSON.stringify({
      event: 'start',
      ucid: `wss-test-${Date.now()}`,
      did: 'test-did',
      type: 'text',
      call_id: '919999000000',
      x_account: 'test',
      x_headers: JSON.stringify({ sid: 'test-sid', cid: '919999000000', operator: 'test', circle: 'test' }),
      media: { encoding: 'PCMU', sampleRate: 8000, channels: 1, bitsPerSample: 16, payloadType: 0 },
    })
  );
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    other++;
    return;
  }
  // Bot -> server audio per spec: { seqid, data: { samples, sampleRate } }
  if (msg.data && Array.isArray(msg.data.samples)) {
    mediaFrames++;
    if (mediaFrames === 1) console.log('FIRST GREETING MEDIA FRAME received');
    if (mediaFrames >= 30) {
      clearTimeout(timer);
      console.log(`SUCCESS: received ${mediaFrames} greeting media frames (bot speaks over WS)`);
      ws.close();
      process.exit(0);
    }
  } else {
    other++;
    console.log('other message:', JSON.stringify(msg).slice(0, 200));
  }
});

ws.on('error', (e) => {
  clearTimeout(timer);
  console.log(`WS ERROR: ${e.message}`);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log(`WS CLOSED code=${code} reason=${reason} mediaFrames=${mediaFrames} other=${other}`);
});
