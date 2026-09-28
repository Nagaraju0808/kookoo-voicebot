require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { frameRms, chunk } = require('./lib/wav');
const { transcribe, reason, speak, TRANSFER_ENABLED, BRAIN_MODEL, STT_MODEL, TTS_MODEL } = require('./lib/ai');
const rag = require('./lib/rag');

const PORT = process.env.PORT || 3000;
const SIP_NUMBER = process.env.SIP_NUMBER || '1';
const WS_PATH = '/ws';

const VAD_THRESHOLD = parseInt(process.env.VAD_THRESHOLD || '300', 10);
const VAD_SILENCE_MS = parseInt(process.env.VAD_SILENCE_MS || '800', 10);
const MAX_UTTERANCE_SECONDS = parseInt(process.env.MAX_UTTERANCE_SECONDS || '30', 10);
const INACTIVITY_TIMEOUT_MS = parseInt(process.env.INACTIVITY_TIMEOUT_MS || '12000', 10);

// Bot audio is sent as 10 ms frames at 8 kHz; the media server re-paces to 10 ms RTP
// and queues up to 60 s, so we stay a little ahead of real time to avoid gaps.
const TTS_RATE = 8000;
const FRAME_SAMPLES = 80;
const SEND_LEAD_MS = parseInt(process.env.SEND_LEAD_MS || '200', 10);

// Live-agent transfer (Stream webhook -> <cctransfer>). Disabled when TRANSFER_SKILL is unset.
const TRANSFER_SKILL = process.env.TRANSFER_SKILL || '';
const TRANSFER_UUI = process.env.TRANSFER_UUI || 'voicebot';
const TRANSFER_TIMEOUT = process.env.TRANSFER_TIMEOUT || '30';
const TRANSFER_RING_TYPE = process.env.TRANSFER_RING_TYPE || 'ring';
const TRANSFER_MOH = process.env.TRANSFER_MOH || '';
const TRANSFER_HOLD_MUSIC = process.env.TRANSFER_HOLD_MUSIC || '';

const GREETING = process.env.GREETING || 'Hello, thank you for calling. How can I help you today?';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are a professional phone receptionist for a clinic. You answer caller questions using the clinic record index, which you search with the lookup_patient_record tool. Answer ONLY from the records the tool returns; never invent values, names, or dates. If the records do not answer the question, say you could not find that information and offer to connect the caller to the front desk. Mention the patient name when the records show it, for example: I see the records for that patient. Keep every reply to 1 to 3 spoken sentences. Never use markdown, bullet lists, or symbols meant for text. Do not claim to be human; if asked, say you are an AI assistant. Ask a clarifying question only when the records disagree or are silent.';
const CALL_CONTROL_PROMPT = TRANSFER_ENABLED
  ? ' When the caller is finished or says goodbye, call the end_call tool. When the caller asks for a human or accepts your offer to connect them to the front desk, call the transfer_to_agent tool.'
  : ' When the caller is finished or says goodbye, call the end_call tool. Live transfer is not available, so if the caller wants a human, tell them to call back during front desk hours.';

// sid -> { type: 'transfer' | 'hangup', reason, at }. Set by the bot before it
// sends callDisconnect; read by the Stream webhook; cleared on Hangup.
const pendingActions = new Map();
const PENDING_TTL_MS = 60 * 60 * 1000;

// cid -> sid mapping for fallback correlation if carrier strips x_headers
const recentCallsByCid = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getWebSocketUrl(req) {
  if (process.env.WS_URL) {
    return process.env.WS_URL.replace(/\/+$/, '');
  }
  const publicDomain = process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
  if (publicDomain) {
    let base = publicDomain.trim();
    if (!/^https?:\/\/|^wss?:\/\//i.test(base)) {
      base = `https://${base}`;
    }
    const wsBase = base
      .replace(/^https:\/\//i, 'wss://')
      .replace(/^http:\/\//i, 'ws://')
      .replace(/\/+$/, '');
    return `${wsBase}${WS_PATH}`;
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  return `${wsProto}://${host}${WS_PATH}`;
}

// Step 1 — NewCall: connect the caller to the bot over a SIP leg.
function streamXml(params, wsUrl, sipNumber) {
  const uui = JSON.stringify(params).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <start-record></start-record>
  <stream is_sip="true" moh="silence" url="${xmlAttr(wsUrl)}" x-uui='${uui}'>${xmlAttr(sipNumber)}</stream>
</response>`;
}

// Step 2 — Stream, option A: transfer the caller to a live agent skill queue.
function transferXml(action) {
  const attrs = [
    `record=""`,
    TRANSFER_MOH && `moh="${xmlAttr(TRANSFER_MOH)}"`,
    TRANSFER_HOLD_MUSIC && `caller_onhold_music="${xmlAttr(TRANSFER_HOLD_MUSIC)}"`,
    `uui="${xmlAttr(action.reason ? `${TRANSFER_UUI}: ${action.reason}`.slice(0, 120) : TRANSFER_UUI)}"`,
    `timeout="${xmlAttr(TRANSFER_TIMEOUT)}"`,
    `ringType="${xmlAttr(TRANSFER_RING_TYPE)}"`,
  ].filter(Boolean);
  return `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <cctransfer ${attrs.join(' ')}>${xmlAttr(TRANSFER_SKILL)}</cctransfer>
</response>`;
}

// Step 2 option B / Step 3 — end the call, or acknowledge Hangup.
const HANGUP_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<response>\n  <hangup></hangup>\n</response>';

class CallSession {
  constructor(ws, startMsg) {
    this.ws = ws;
    this.ucid = startMsg.ucid;
    this.did = startMsg.did;
    this.callId = startMsg.call_id;
    this.uui = this.parseUui(startMsg);
    this.sid = this.uui.sid || (this.callId && recentCallsByCid.get(this.callId)) || null;
    this.caller = {
      number: startMsg.call_id || this.uui.cid,
      operator: this.uui.operator,
      circle: this.uui.circle,
      country: this.uui.cid_countryname,
    };
    const media = startMsg.media || {};
    this.sampleRate = media.sampleRate || 8000;
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT + CALL_CONTROL_PROMPT }];

    // Audio buffering and VAD state
    this.speechBuffer = [];
    this.preRoll = [];
    this.isSpeaking = false;
    this.speechFrameCount = 0;
    this.bargeFrameCount = 0;
    this.hadSpeech = false;

    // Controllers and timers
    this.abortController = new AbortController();
    this.idleTimer = null;
    this.inactivityTimer = null;
    this.inactivityCount = 0;
    this.streaming = false;
    this.processing = false;
    this.pendingTalk = [];
    this.uttCounter = 0;
    this.closed = false;
    this.ending = false;
    this.t0 = Date.now();
    this.mediaIn = 0;
    this.mediaOut = 0;
    this.probeSeen = false;
    this.lastSeqid = null;
    this.elapsed = () => `${((Date.now() - this.t0) / 1000).toFixed(1)}s`;

    console.log(
      `[CALL START] ucid=${this.ucid} sid=${this.sid || '-'} caller=${this.caller.number} did=${this.did} ` +
        `codec=${media.encoding || 'PCMU'}/${this.sampleRate} ch=${media.channels || 1} pt=${media.payloadType ?? '-'}`
    );

    rag
      .init()
      .then(() => console.log(`[RAG] index ready ucid=${this.ucid}`))
      .catch((e) => console.error(`[RAG INIT ERROR] ucid=${this.ucid}: ${e.message}`));

    this.greet();
  }

  // x_headers is the raw X-Uui header: the JSON we put in x-uui on NewCall.
  parseUui(startMsg) {
    try {
      let raw = startMsg.x_headers;
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw);
        } catch {
          return JSON.parse(decodeURIComponent(raw));
        }
      }
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  async greet() {
    try {
      if (GREETING) {
        console.log(`[GREET] ucid=${this.ucid} t=${this.elapsed()} speaking ${GREETING.length} chars`);
        await this.speak(GREETING);
        console.log(`[GREET DONE] ucid=${this.ucid} t=${this.elapsed()} sent=${this.mediaOut} frames`);
      }
      this.resetInactivityTimer();
    } catch (e) {
      if (!this.closed) console.error(`[GREET ERROR] ${this.ucid}: ${e.message}`);
    }
  }

  resetInactivityTimer() {
    this.clearInactivityTimer();
    if (this.closed || this.ending) return;
    this.inactivityTimer = setTimeout(async () => {
      if (this.closed || this.ending || this.streaming || this.processing || this.isSpeaking) return;
      this.inactivityCount++;
      if (this.inactivityCount === 1) {
        console.log(`[INACTIVITY] ucid=${this.ucid} prompting caller (12s silence)`);
        try {
          await this.speak('Are you still there? Please let me know how I can help you today.');
          this.resetInactivityTimer();
        } catch {}
      } else {
        console.log(`[INACTIVITY] ucid=${this.ucid} second timeout reached — ending call`);
        try {
          await this.speak('Thank you for calling. Have a great day. Goodbye.');
        } catch {}
        await this.finishCall({ type: 'hangup', reason: 'inactivity timeout' });
      }
    }, INACTIVITY_TIMEOUT_MS);
  }

  clearInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  onMedia(msg) {
    // DTMF Tones (Step 5)
    if (msg.type === 'dtmf') {
      const signal = String(msg.signal || '').trim();
      console.log(`[DTMF] ucid=${this.ucid} signal=${signal}`);
      if (this.streaming) {
        this.bargeIn();
      }
      this.handleDtmf(signal);
      return;
    }

    // Inbound Audio (Step 4)
    const data = msg.data;
    if (!data || !Array.isArray(data.samples)) return;
    this.mediaIn++;
    if (this.mediaIn === 1) {
      console.log(`[MEDIA IN] ucid=${this.ucid} t=${this.elapsed()} first frame rate=${data.sampleRate} len=${data.samples.length}`);
    }
    if (this.ending || this.closed) return;

    if (data.sampleRate && data.sampleRate !== this.sampleRate) {
      console.log(`[MEDIA IN] ucid=${this.ucid} sample rate changed ${this.sampleRate} -> ${data.sampleRate}`);
      this.speechBuffer = [];
      this.preRoll = [];
      this.isSpeaking = false;
      this.sampleRate = data.sampleRate;
    }

    if (!this.probeSeen) {
      this.probeSeen = true;
      console.log(`[PROBE] ucid=${this.ucid} first frame seen`);
      return;
    }

    const rms = frameRms(data.samples);

    // If bot is currently outputting speech, check for caller barge-in
    if (this.streaming) {
      if (rms > VAD_THRESHOLD) {
        this.bargeFrameCount++;
        // 2 consecutive frames of speech (~20-40 ms) interrupts bot playback
        if (this.bargeFrameCount >= 2) {
          console.log(`[BARGE-IN TRIGGERED] ucid=${this.ucid} rms=${rms.toFixed(0)}`);
          this.bargeFrameCount = 0;
          this.bargeIn();
          // Immediately start capturing this speech
          this.isSpeaking = true;
          this.speechBuffer = [...data.samples];
          this.scheduleFinalize();
          return;
        }
      } else {
        this.bargeFrameCount = 0;
      }
      return;
    }

    // Bot is not streaming — caller's speaking turn
    if (rms > VAD_THRESHOLD) {
      this.clearInactivityTimer();
      this.inactivityCount = 0;
      this.speechFrameCount++;

      if (!this.isSpeaking && this.speechFrameCount >= 2) {
        this.isSpeaking = true;
        // Prepend rolling pre-roll buffer so the start of speech isn't clipped
        this.speechBuffer = [...this.preRoll, ...data.samples];
      } else if (this.isSpeaking) {
        this.speechBuffer.push(...data.samples);
      }

      if (this.isSpeaking) {
        this.scheduleFinalize();
      }

      if (this.speechBuffer.length > this.sampleRate * MAX_UTTERANCE_SECONDS) {
        this.finalizeUtterance();
      }
    } else {
      // Below threshold: silence
      this.speechFrameCount = 0;
      if (this.isSpeaking) {
        this.speechBuffer.push(...data.samples);
        if (!this.idleTimer) {
          this.scheduleFinalize();
        }
      } else {
        // Not speaking: maintain rolling ~300ms pre-roll buffer
        this.preRoll.push(...data.samples);
        const maxPreRoll = Math.floor(this.sampleRate * 0.3);
        if (this.preRoll.length > maxPreRoll) {
          this.preRoll.splice(0, this.preRoll.length - maxPreRoll);
        }
      }
    }
  }

  async handleDtmf(signal) {
    if (this.closed || this.ending) return;
    if (signal === '0') {
      if (TRANSFER_ENABLED) {
        console.log(`[DTMF] ucid=${this.ucid} caller pressed 0 -> transferring to agent`);
        try {
          await this.speak('Connecting you to the front desk now. Please hold.');
        } catch {}
        await this.finishCall({ type: 'transfer', reason: 'Caller pressed 0 for live agent' });
        return;
      } else {
        try {
          await this.speak('Live transfer is currently not available. How else may I assist you?');
        } catch {}
        this.resetInactivityTimer();
        return;
      }
    }
    this.messages.push({ role: 'user', content: `[Caller pressed keypad digit ${signal}]` });
    try {
      const { text: reply, action } = await reason(this.messages, { ucid: this.ucid }, this.abortController.signal);
      if (reply) {
        this.messages.push({ role: 'assistant', content: reply });
        await this.speak(reply);
      }
      if (action) {
        await this.finishCall(action);
      } else {
        this.resetInactivityTimer();
      }
    } catch (e) {
      if (!this.closed) console.error(`[DTMF ERROR] ucid=${this.ucid}: ${e.message}`);
    }
  }

  scheduleFinalize() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.finalizeUtterance(), VAD_SILENCE_MS);
  }

  finalizeUtterance() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.closed || this.ending) {
      this.speechBuffer = [];
      this.isSpeaking = false;
      return;
    }
    // Ignore utterances shorter than 250 ms
    if (!this.isSpeaking || this.speechBuffer.length < this.sampleRate / 4) {
      this.speechBuffer = [];
      this.isSpeaking = false;
      return;
    }
    const utterance = this.speechBuffer;
    this.speechBuffer = [];
    this.preRoll = [];
    this.isSpeaking = false;
    this.pendingTalk.push({ samples: utterance, sampleRate: this.sampleRate });
    this.pump();
  }

  async pump() {
    if (this.processing || this.closed) return;
    this.processing = true;
    while (this.pendingTalk.length > 0) {
      if (this.closed || this.ending) break;
      const utterance = this.pendingTalk.shift();
      try {
        const text = await transcribe(utterance.samples, utterance.sampleRate, this.abortController.signal);
        console.log(`[STT] ucid=${this.ucid} caller: ${text}`);
        const meaningful = (text || '').replace(/[^a-zA-Z0-9]/g, '').trim();
        if (meaningful.length < 2) continue;

        this.messages.push({ role: 'user', content: text });
        const { text: reply, action } = await reason(this.messages, { ucid: this.ucid }, this.abortController.signal);
        console.log(`[AI] ucid=${this.ucid} bot: ${reply}${action ? ` [action=${action.type}]` : ''}`);
        this.messages.push({ role: 'assistant', content: reply });

        if (this.messages.length > 12) {
          const overflow = this.messages.length - 12;
          let drop = overflow;
          while (
            drop < this.messages.length - 1 &&
            this.messages[1 + drop] &&
            this.messages[1 + drop].role === 'tool'
          ) {
            drop++;
          }
          if (drop > 0) this.messages.splice(1, drop);
        }

        if (action) this.ending = true;
        const outBefore = this.mediaOut;
        if (reply) await this.speak(reply);
        console.log(`[SPOKEN] ucid=${this.ucid} t=${this.elapsed()} sent=${this.mediaOut - outBefore} frames`);

        if (action) {
          await this.finishCall(action);
          break;
        } else {
          this.resetInactivityTimer();
        }
      } catch (e) {
        if (this.closed) break;
        console.error(`[ERROR] ucid=${this.ucid}: ${e.message}`);
        if (this.ending) {
          await this.finishCall({ type: 'hangup' });
          break;
        }
        try {
          await this.speak('Sorry, I did not catch that. Could you please repeat?');
          this.resetInactivityTimer();
        } catch {}
      }
    }
    this.processing = false;
  }

  async speak(text) {
    if (this.closed) return;
    this.streaming = true;
    this.bargeFrameCount = 0;
    try {
      const parsed = await speak(text, this.abortController.signal);
      const uttId = `utt-${++this.uttCounter}`;
      const frames = chunk(parsed.samples, FRAME_SAMPLES);
      const frameMs = (FRAME_SAMPLES * 1000) / TTS_RATE;
      const tStart = Date.now();
      for (let i = 0; i < frames.length; i++) {
        if (!this.streaming || this.closed) {
          console.log(`[SPEAK CUT] ucid=${this.ucid} t=${this.elapsed()} sent=${i}/${frames.length}`);
          break;
        }
        this.sendMedia(frames[i], `${uttId}-${String(i).padStart(5, '0')}`);
        this.mediaOut++;
        // Clock-based pacing to prevent RTP buffer underflow/overflow
        const ahead = tStart + (i + 1) * frameMs - SEND_LEAD_MS - Date.now();
        if (ahead > 0) await sleep(ahead);
      }
    } finally {
      this.streaming = false;
      this.bargeFrameCount = 0;
    }
  }

  // Step 8 — barge-in: drop queued audio on the media server and stop sending locally
  bargeIn() {
    console.log(`[BARGE-IN] ucid=${this.ucid} interrupting bot audio`);
    this.streaming = false;
    this.send({ command: 'clearBuffer', extension: String(SIP_NUMBER), sessionId: this.ucid });
  }

  // Step 7 — mark: server acknowledges clearBuffer and reports the interrupted seqid
  onMark(msg) {
    this.lastSeqid = msg.seqid;
    console.log(`[MARK] ucid=${this.ucid} cleared at seqid=${msg.seqid} ts=${msg.timestamp}`);
  }

  // Step 6 — bot audio: PCM-16 samples, media server encodes to PCMU/RTP
  sendMedia(samples, seqid) {
    this.send({ seqid, data: { samples, sampleRate: TTS_RATE } });
  }

  // Step 9 — hang up the bot leg. The IVR then calls the Stream webhook, which
  // answers <cctransfer> or <hangup> based on the action stored here.
  async finishCall(action) {
    if (this.closed) return;
    this.clearInactivityTimer();
    if (action.type === 'transfer' && !this.sid) {
      console.warn(`[FINISH] ucid=${this.ucid} no sid found — hanging up`);
    }
    if (this.sid) {
      pendingActions.set(String(this.sid), { ...action, at: Date.now() });
    }
    // Allow any audio in-flight on the server buffer to reach the caller
    await sleep(SEND_LEAD_MS + 600);
    if (this.closed) return;
    console.log(`[DISCONNECT] ucid=${this.ucid} sid=${this.sid || '-'} action=${action.type}`);
    this.send({ command: 'callDisconnect', causeCode: 200 });
  }

  send(obj) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error(`[WS SEND ERROR] ucid=${this.ucid}: ${e.message}`);
    }
  }

  // Step 10 — stop: cause 433 = normal hangup; no cause = SIP failure/rejection
  onStop(msg) {
    const why = msg.cause === undefined ? 'sip-failure' : msg.cause === 433 ? '433 (caller hangup)' : msg.cause;
    this.release();
    const t = `${((Date.now() - this.t0) / 1000).toFixed(1)}s`;
    console.log(`[CALL END] ucid=${this.ucid} cause=${why} duration=${t} mediaIn=${this.mediaIn} mediaOut=${this.mediaOut}`);
  }

  release() {
    if (this.closed) return;
    this.closed = true;
    this.streaming = false;
    this.clearInactivityTimer();
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.abortController.abort();
    this.speechBuffer = [];
    this.preRoll = [];
    this.pendingTalk = [];
  }
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/health', (req, res) =>
  res.json({ ok: true, brain: BRAIN_MODEL, stt: STT_MODEL, tts: TTS_MODEL, transfer: TRANSFER_SKILL || null })
);

// IVR call-lifecycle webhook: NewCall -> Stream -> Hangup (all GET, XML replies)
// Supports /kookoo, /api/ivr/webhook, and /webhook
app.all(['/kookoo', '/api/ivr/webhook', '/webhook'], (req, res) => {
  const params = { ...req.query, ...req.body };
  const sid = params.sid ? String(params.sid) : '';
  const cid = params.cid || params.cid_e164 || '';
  if (sid && cid) {
    recentCallsByCid.set(String(cid), sid);
  }

  console.log(`[KooKoo IVR] path=${req.path} sid=${sid || '-'} event=${params.event || '-'}`);
  res.set('Content-Type', 'text/xml; charset=utf-8');

  // Step 1 — NewCall
  if (params.event === 'NewCall') {
    const isTestPing = !params.sid && !params.cid;
    if (isTestPing) {
      console.log('[KooKoo IVR] note: portal "Test Application URL" ping (no call follows)');
    } else {
      console.log(
        `[KooKoo IVR] NewCall caller=${params.cid_e164 || params.cid} did=${params.called_number} ` +
          `operator=${params.operator || '-'} circle=${params.circle || '-'}`
      );
    }
    const wsUrl = getWebSocketUrl(req);
    return res.send(streamXml(params, wsUrl, SIP_NUMBER));
  }

  // Step 2 — Stream
  if (params.event === 'Stream') {
    const action = sid ? pendingActions.get(sid) : null;
    console.log(
      `[KooKoo IVR] Stream status=${params.status || '-'} callduration=${params.callduration || '-'}s action=${action ? action.type : 'none'}`
    );
    if (action && action.type === 'transfer' && TRANSFER_SKILL) {
      console.log(`[KooKoo IVR] transferring sid=${sid} to skill=${TRANSFER_SKILL}`);
      return res.send(transferXml(action));
    }
    return res.send(HANGUP_XML);
  }

  // Step 3 — Hangup
  if (params.event === 'Hangup') {
    if (sid) pendingActions.delete(sid);
    console.log(
      `[KooKoo IVR] Hangup status=${params.status || '-'} talk=${params.callduration || '-'}s total=${params.total_call_duration || '-'}s ` +
        `recording=${params.call_recording_url || params.data || '-'}`
    );
    return res.send(HANGUP_XML);
  }

  return res.send(HANGUP_XML);
});

// Drop stale actions for calls whose Hangup webhook never arrived
setInterval(() => {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [sid, a] of pendingActions) if (a.at < cutoff) pendingActions.delete(sid);
  if (recentCallsByCid.size > 500) recentCallsByCid.clear();
}, 10 * 60 * 1000).unref();

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Accept WebSocket upgrades on /ws, /api/ivr/ws, or /
server.on('upgrade', (request, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  } catch {}

  if (pathname === WS_PATH || pathname === '/api/ivr/ws' || pathname === '/' || pathname === '') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const ip = (req && req.socket && req.socket.remoteAddress) || '?';
  console.log(`[WS CONNECT] from=${ip}`);
  let session = null;
  let alive = true;

  ws.on('pong', () => {
    alive = true;
  });

  const keepalive = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(keepalive);
      return;
    }
    if (!alive) {
      clearInterval(keepalive);
      console.log(`[WS DEAD] ucid=${session ? session.ucid : '-'} no pong — terminating half-open socket`);
      try {
        ws.terminate();
      } catch {}
      if (session) session.release();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {}
  }, 20000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg.event) return;

    if (msg.event === 'start') {
      if (session) session.release();
      session = new CallSession(ws, msg);
    } else if (msg.event === 'media') {
      if (session) session.onMedia(msg);
    } else if (msg.event === 'mark') {
      if (session) session.onMark(msg);
      else console.log(`[MARK] ucid=${msg.ucid} seqid=${msg.seqid}`);
    } else if (msg.event === 'stop') {
      if (session) session.onStop(msg);
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(keepalive);
    console.log(`[WS CLOSE] code=${code} reason=${reason || ''} ucid=${session ? session.ucid : '-'}`);
    if (session) session.release();
  });

  ws.on('error', (err) => {
    console.error('[WS ERROR]', err.message);
    if (session) session.release();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`KooKoo Groq voicebot listening on 0.0.0.0:${PORT}`);
  console.log(`Webhook endpoints: /kookoo, /api/ivr/webhook, /webhook`);
  console.log(`WebSocket endpoint: ${WS_PATH}`);
  console.log(`Models: brain=${BRAIN_MODEL} stt=${STT_MODEL} tts=${TTS_MODEL} voice=${process.env.TTS_VOICE || 'hannah'}`);
  console.log(`Live-agent transfer: ${TRANSFER_SKILL ? `skill=${TRANSFER_SKILL}` : 'disabled (set TRANSFER_SKILL)'}`);
});
