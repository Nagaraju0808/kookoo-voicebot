const Groq = require('groq-sdk');
const { makeWav, parseWav, upsample, downsample } = require('./wav');
const rag = require('./rag');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BRAIN_MODEL = process.env.BRAIN_MODEL || 'qwen/qwen3.8-27b';
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3-turbo';
const TTS_MODEL = process.env.TTS_MODEL || 'canopylabs/orpheus-v1-english';
const TTS_VOICE = process.env.TTS_VOICE || 'hannah';

// Timeouts so a stalled Groq call can never silence a live call forever.
// The pump catches timeout errors and speaks a short fallback instead.
const STT_TIMEOUT_MS = parseInt(process.env.GROQ_STT_TIMEOUT_MS || '15000', 10);
const BRAIN_TIMEOUT_MS = parseInt(process.env.GROQ_BRAIN_TIMEOUT_MS || '20000', 10);
const TTS_TIMEOUT_MS = parseInt(process.env.GROQ_TTS_TIMEOUT_MS || '25000', 10);

// The call's sample rate is negotiated from SDP (8k/16k/24k/48k). 8 kHz is
// upsampled to 16 kHz for Whisper; higher rates are sent as-is.
async function transcribe(samples, sampleRate = 8000, signal = null) {
  const wav = sampleRate === 8000 ? makeWav(upsample(samples, 2), 16000) : makeWav(samples, sampleRate);
  const form = new FormData();
  form.append('model', STT_MODEL);
  form.append('language', 'en');
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STT_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new Error('STT aborted: session closed');
    }
    signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`STT failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return (data.text || '').trim();
  } catch (e) {
    if (e.name === 'AbortError' || ctrl.signal.aborted) {
      if (signal && signal.aborted) throw new Error('STT aborted: session closed');
      throw new Error(`STT timed out after ${STT_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const RETRIEVAL_TOOL = {
  type: 'function',
  function: {
    name: 'lookup_patient_record',
    description: 'Search the local clinic knowledge index for a specific fact about a patient or the clinic, e.g. blood pressure, medicines, allergies, next appointment, doctor, visiting hours, prescription refills, record copies. Query should be a short factual question. Include the patient name and the fact you need.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Short factual question about the patient records' },
      },
      required: ['query'],
    },
  },
};

// Call-control tools. The bot never hangs up or transfers directly: it returns
// an action, the session speaks the reply, then sends `callDisconnect`. The IVR
// then fires the `Stream` webhook, which answers <cctransfer> or <hangup>.
const END_CALL_TOOL = {
  type: 'function',
  function: {
    name: 'end_call',
    description: 'End the phone call. Use only when the caller says goodbye, says they need nothing else, or asks to hang up.',
    parameters: { type: 'object', properties: {} },
  },
};

const TRANSFER_TOOL = {
  type: 'function',
  function: {
    name: 'transfer_to_agent',
    description: 'Transfer the caller to a live human agent at the front desk. Use when the caller asks for a human, or accepts your offer to connect them to the front desk.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for the transfer, passed to the agent' },
      },
    },
  },
};

const TRANSFER_ENABLED = !!process.env.TRANSFER_SKILL;

function callTools() {
  return TRANSFER_ENABLED ? [RETRIEVAL_TOOL, END_CALL_TOOL, TRANSFER_TOOL] : [RETRIEVAL_TOOL, END_CALL_TOOL];
}

let ragReadyPromise = null;
function ensureRag() {
  if (!ragReadyPromise) ragReadyPromise = rag.init();
  return ragReadyPromise;
}

async function runRetrieval(args) {
  await ensureRag();
  const chunks = await rag.query((args && args.query) || '', 5);
  return rag.retrievalResult(chunks);
}

async function reason(messages, ctx = {}, signal = null) {
  const ucid = ctx.ucid || '-';
  const t0 = Date.now();
  const res = await groq.chat.completions.create(
    {
      model: BRAIN_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: parseInt(process.env.BRAIN_MAX_TOKENS || '160', 10),
      tools: callTools(),
    },
    { timeout: BRAIN_TIMEOUT_MS, signal }
  );
  console.log(`[BRAIN] ucid=${ucid} first-pass ${Date.now() - t0}ms`);
  const msg = res.choices[0].message;
  if (!msg.tool_calls || !msg.tool_calls.length) {
    return { text: (msg.content || '').trim(), action: null };
  }
  let action = null;
  const results = [];
  for (const tc of msg.tool_calls) {
    let result;
    const name = tc.function && tc.function.name;
    if (name === END_CALL_TOOL.function.name) {
      action = action || { type: 'hangup' };
      console.log(`[TOOL] end_call ucid=${ucid}`);
      result = 'OK: the call will end right after your reply. Say a brief, polite goodbye.';
    } else if (name === TRANSFER_TOOL.function.name && TRANSFER_ENABLED) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {}
      action = { type: 'transfer', reason: args.reason || '' };
      console.log(`[TOOL] transfer_to_agent ucid=${ucid} reason=${args.reason || ''}`);
      result = 'OK: the caller will be transferred to the front desk right after your reply. Tell them briefly that you are connecting them now.';
    } else if (name === RETRIEVAL_TOOL.function.name) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {}
      console.log(`[TOOL] ${RETRIEVAL_TOOL.function.name} ucid=${ucid} query=${args.query || ''}`);
      try {
        result = await runRetrieval(args);
      } catch (e) {
        console.error(`[TOOL ERROR] ucid=${ucid}: ${e.message}`);
        result =
          'NOT_FOUND: the local record index is unavailable right now. ' +
          'Tell the caller you could not find that information and offer to ' +
          'connect them to the front desk. Do not guess.';
      }
      console.log(`[TOOL RESULT] ucid=${ucid} ${String(result).replace(/\s+/g, ' ').slice(0, 140)}...`);
    } else {
      result = `Unknown tool: ${tc.function && tc.function.name}. Do not guess; answer from the records you already have or say you cannot find it.`;
    }
    results.push({ tc, result });
  }
  const followup = [
    ...messages,
    { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls },
    ...results.map(({ tc, result }) => ({ role: 'tool', tool_call_id: tc.id, content: result })),
  ];
  const final = await groq.chat.completions.create(
    {
      model: BRAIN_MODEL,
      messages: followup,
      temperature: 0.7,
      max_tokens: parseInt(process.env.BRAIN_MAX_TOKENS || '160', 10),
    },
    { timeout: BRAIN_TIMEOUT_MS, signal }
  );
  console.log(`[BRAIN] ucid=${ucid} total ${Date.now() - t0}ms (tool loop)`);
  let text = (final.choices[0].message.content || '').trim();
  if (!text && action) {
    text = action.type === 'transfer' ? 'Please hold while I connect you to the front desk.' : 'Thank you for calling. Goodbye.';
  }
  return { text, action };
}

async function speak(text, signal = null) {
  let input = (text || '').trim().replace(/[*_#`~]/g, '');
  if (input.length > 400) {
    const boundary = Math.max(input.lastIndexOf('.', 400), input.lastIndexOf('!', 400), input.lastIndexOf('?', 400));
    input = boundary > 100 ? input.slice(0, boundary + 1) : input.slice(0, 400);
  }
  const t0 = Date.now();
  const resp = await groq.audio.speech.create(
    {
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input,
      response_format: 'wav',
      sample_rate: 24000,
    },
    { timeout: TTS_TIMEOUT_MS, signal }
  );
  const buf = Buffer.from(await resp.arrayBuffer());
  const wav = parseWav(buf);
  const rate = wav.sampleRate || 24000;
  const factor = rate === 8000 ? 1 : Math.round(rate / 8000);
  const samples = factor === 1 ? wav.samples : downsample(wav.samples, factor);
  console.log(`[TTS] ${Date.now() - t0}ms chars=${input.length} rate=${rate} factor=${factor} samples=${samples.length}`);
  return { ...wav, sampleRate: 8000, samples };
}

module.exports = { transcribe, reason, speak, RETRIEVAL_TOOL, TRANSFER_ENABLED, BRAIN_MODEL, STT_MODEL, TTS_MODEL };