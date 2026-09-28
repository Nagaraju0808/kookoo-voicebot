// Capture the bot's greeting audio over WSS and analyze it.
// Saves greeting-8k.wav + prints RMS/peak/duration stats.
// Usage: node scripts/wss-capture.mjs [wsUrl]
import { createRequire } from 'module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const { makeWav, frameRms } = require('../lib/wav.js');

const url = process.argv[2] || 'wss://nagarajupc.tail0e2475.ts.net/ws';
console.log(`connecting to ${url} ...`);

const ws = new WebSocket(url, { handshakeTimeout: 15000 });
const allSamples = [];
let frames = 0;
let firstShape = null;

const timer = setTimeout(() => {
  console.log('TIMEOUT after 25s');
  finish(2);
}, 25000);

function finish(code) {
  clearTimeout(timer);
  try {
    ws.close();
  } catch {}
  const n = allSamples.length;
  const rms = n ? frameRms(allSamples) : 0;
  let peak = 0;
  for (const s of allSamples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  console.log(`frames=${frames} samples=${n} duration8k=${(n / 8000).toFixed(2)}s rms=${rms.toFixed(1)} peak=${peak}`);
  if (n) {
    const out = '/tmp/voicebot-greeting-8k.wav';
    fs.writeFileSync(out, makeWav(allSamples, 8000));
    console.log(`saved ${out}`);
  }
  process.exit(code);
}

ws.on('open', () => {
  console.log('WS OPEN — sending start event');
  ws.send(
    JSON.stringify({
      event: 'start',
      ucid: `wss-cap-${Date.now()}`,
      did: 'test-did',
      call_id: '919999000000',
      x_headers: JSON.stringify({ cid: '919999000000' }),
    })
  );
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.event === 'media' && msg.data && Array.isArray(msg.data.samples)) {
    frames++;
    if (!firstShape) {
      firstShape = {
        sampleRate: msg.data.sampleRate,
        bitsPerSample: msg.data.bitsPerSample,
        channelCount: msg.data.channelCount,
        numberOfFrames: msg.data.numberOfFrames,
        frameLen: msg.data.samples.length,
        keys: Object.keys(msg),
      };
      console.log('first media shape:', JSON.stringify(firstShape));
    }
    allSamples.push(...msg.data.samples);
    if (frames >= 400) {
      console.log('collected 400 frames, stopping');
      finish(0);
    }
  }
});

ws.on('error', (e) => {
  console.log(`WS ERROR: ${e.message}`);
  finish(1);
});
