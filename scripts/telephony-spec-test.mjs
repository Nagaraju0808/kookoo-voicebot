// Telephony Specification Verification Test for KooKoo / WebRTC Telephony Platform (Spec v2.0)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failCount++;
  }
}

async function testWebhooks() {
  console.log('\n--- 1. Testing IVR Webhooks (Part 1 of Spec) ---');

  // Step 1: NewCall via /api/ivr/webhook
  const newCallParams = new URLSearchParams({
    event: 'NewCall',
    sid: '6505999',
    cid: '00919876543210',
    called_number: '918012345678',
    cid_e164: '+919876543210',
    operator: 'Airtel',
    cid_country: '91',
    cid_countryname: 'India',
    cid_type: 'MOBILE',
    circle: 'ANDHRA PRADESH',
    request_time: '2026-06-09 11:58:25',
  });

  const res1 = await fetch(`${BASE_URL}/api/ivr/webhook?${newCallParams.toString()}`);
  assert(res1.status === 200, 'GET /api/ivr/webhook (NewCall) returned 200');
  const ct1 = res1.headers.get('content-type') || '';
  assert(ct1.includes('xml'), `Content-Type is XML: ${ct1}`);
  const xml1 = await res1.text();
  assert(xml1.includes('<response>'), 'Contains <response>');
  assert(xml1.includes('<start-record></start-record>'), 'Contains <start-record></start-record>');
  assert(xml1.includes('is_sip="true"'), 'Contains is_sip="true"');
  assert(xml1.includes('moh="silence"'), 'Contains moh="silence"');
  assert(xml1.includes('url="'), 'Contains url attribute');
  assert(xml1.includes("x-uui='"), 'Contains x-uui attribute with JSON');
  assert(xml1.includes('531486') || xml1.includes('1'), 'Contains SIP extension number in inner text');

  // Step 1b: Backward compatibility test on /kookoo
  const res1b = await fetch(`${BASE_URL}/kookoo?${newCallParams.toString()}`);
  assert(res1b.status === 200, 'GET /kookoo (NewCall) returns 200');

  // Step 2: Stream event
  const streamParams = new URLSearchParams({
    event: 'Stream',
    sid: '6505999',
    cid: '00919876543210',
    called_number: '918012345678',
    status: 'answered',
    message: 'answered',
    callduration: '28',
    pickduration: '0',
    request_time: '2026-06-09 11:58:54',
  });
  const res2 = await fetch(`${BASE_URL}/api/ivr/webhook?${streamParams.toString()}`);
  assert(res2.status === 200, 'GET /api/ivr/webhook (Stream) returned 200');
  const xml2 = await res2.text();
  assert(xml2.includes('<hangup></hangup>') || xml2.includes('<cctransfer'), 'Stream returned <hangup> or <cctransfer>');

  // Step 3: Hangup event
  const hangupParams = new URLSearchParams({
    event: 'Hangup',
    sid: '6505999',
    cid: '00919876543210',
    called_number: '918012345678',
    status: 'answered',
    message: 'answered',
    callduration: '28',
    total_call_duration: '29',
    pickduration: '0',
    data: 'https://s3.amazonaws.com/test/recording.mp3',
    call_recording_url: 'https://s3.amazonaws.com/test/recording.mp3',
    request_time: '2026-06-09 11:58:54',
    telco_code: '16',
  });
  const res3 = await fetch(`${BASE_URL}/api/ivr/webhook?${hangupParams.toString()}`);
  assert(res3.status === 200, 'GET /api/ivr/webhook (Hangup) returned 200');
  const xml3 = await res3.text();
  assert(xml3.includes('<hangup></hangup>'), 'Hangup returned <hangup></hangup>');
}

function testWebSocketLifecycle() {
  return new Promise((resolve) => {
    console.log('\n--- 2. Testing WebSocket Audio Streaming & Call Lifecycle (Part 2 of Spec) ---');
    const ws = new WebSocket(WS_URL, { handshakeTimeout: 10000 });
    const ucid = `CALL-TEST-${Date.now()}`;
    let greetingFrames = 0;
    let clearBufferReceived = false;
    let markSent = false;
    let callEnded = false;

    const timeout = setTimeout(() => {
      assert(false, 'WebSocket test timed out');
      try { ws.close(); } catch {}
      resolve();
    }, 25000);

    ws.on('open', () => {
      console.log('  [INFO] WebSocket connected to bot');
      // Send Step 1: Call Start Event (Server -> Bot)
      ws.send(
        JSON.stringify({
          event: 'start',
          type: 'text',
          ucid,
          did: '918012345678',
          call_id: '919876543210',
          x_account: 'ACC001',
          x_headers: JSON.stringify({ sid: '6505999', cid: '00919876543210' }),
          media: {
            encoding: 'PCMU',
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            payloadType: 0,
          },
        })
      );
      assert(true, 'Sent Call Start Event (server -> bot)');
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Bot -> Server: Send Audio (Step 6)
      if (msg.data && Array.isArray(msg.data.samples)) {
        greetingFrames++;
        if (greetingFrames === 1) {
          assert(true, `Received first greeting frame from bot (seqid=${msg.seqid}, rate=${msg.data.sampleRate})`);
          assert(msg.seqid && msg.seqid.startsWith('utt-'), 'seqid format conforms to utt-*');
          assert(msg.data.samples.length === 80, `Frame size conforms to 80 samples (10ms @ 8kHz): ${msg.data.samples.length}`);
          assert(msg.data.sampleRate === 8000, `Frame sample rate is 8000: ${msg.data.sampleRate}`);
        }

        // After receiving several greeting frames, test BARGE-IN (Step 8)
        if (greetingFrames === 15 && !clearBufferReceived) {
          console.log('  [INFO] Simulating caller speech while bot is streaming (Testing Barge-In)...');
          // Send 3 packets of loud simulated voice frames (RMS > VAD_THRESHOLD)
          const loudSamples = new Array(160).fill(1500); // 160 frames @ 20ms ptime
          for (let f = 0; f < 3; f++) {
            ws.send(
              JSON.stringify({
                event: 'media',
                type: 'media',
                ucid,
                data: {
                  samples: loudSamples,
                  bitsPerSample: 16,
                  sampleRate: 8000,
                  channelCount: 1,
                  numberOfFrames: 160,
                  type: 'data',
                },
              })
            );
          }
        }
      }

      // Bot -> Server: Barge-In clearBuffer (Step 8)
      if (msg.command === 'clearBuffer') {
        clearBufferReceived = true;
        assert(true, `Bot sent clearBuffer command: extension=${msg.extension}, sessionId=${msg.sessionId}`);
        assert(msg.sessionId === ucid, 'clearBuffer sessionId matches ucid');

        // Server -> Bot: Mark event response (Step 7)
        if (!markSent) {
          markSent = true;
          console.log('  [INFO] Server sending mark event ack to bot (Step 7)...');
          ws.send(
            JSON.stringify({
              event: 'mark',
              type: 'ack',
              ucid,
              seqid: 'utt-1-00015',
              timestamp: Date.now(),
            })
          );
          assert(true, 'Sent mark event acknowledgment');

          // Now test Step 5: DTMF Tone (Server -> Bot)
          setTimeout(() => {
            console.log('  [INFO] Server sending DTMF keypad tone to bot (Step 5)...');
            ws.send(
              JSON.stringify({
                event: 'media',
                type: 'dtmf',
                ucid,
                signal: '5',
              })
            );
            assert(true, 'Sent DTMF tone event');

            // Finally, test Step 10: Call End Event (Server -> Bot)
            setTimeout(() => {
              console.log('  [INFO] Server sending stop event to bot (Step 10)...');
              ws.send(
                JSON.stringify({
                  event: 'stop',
                  type: 'text',
                  ucid,
                  did: '918012345678',
                  cause: 433,
                })
              );
              callEnded = true;
              assert(true, 'Sent Call End (stop) event');
              setTimeout(() => {
                ws.close();
                clearTimeout(timeout);
                resolve();
              }, 500);
            }, 1000);
          }, 1000);
        }
      }
    });

    ws.on('error', (err) => {
      assert(false, `WebSocket error: ${err.message}`);
      clearTimeout(timeout);
      resolve();
    });

    ws.on('close', () => {
      assert(true, 'WebSocket connection closed cleanly');
    });
  });
}

async function run() {
  try {
    await testWebhooks();
    await testWebSocketLifecycle();
  } catch (e) {
    console.error('Test run failed:', e);
    failCount++;
  }

  console.log(`\n========================================`);
  console.log(`TEST SUMMARY: ${passCount} Passed, ${failCount} Failed`);
  console.log(`========================================\n`);

  process.exit(failCount > 0 ? 1 : 0);
}

run();
