function pcmToBuffer(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

function bufferToPcm(buf) {
  const n = Math.floor(buf.length / 2);
  const samples = new Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2);
  return samples;
}

function buildWavHeader(sampleRate, pcmBytes) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcmBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcmBytes, 40);
  return buf;
}

function makeWav(samples, sampleRate) {
  const pcm = pcmToBuffer(samples);
  return Buffer.concat([buildWavHeader(sampleRate, pcm.length), pcm]);
}

function parseWav(buf) {
  let off = 12;
  let sampleRate = 8000;
  let channels = 1;
  let bits = 16;
  let samples = [];
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      samples = bufferToPcm(buf.subarray(off + 8, off + 8 + size));
      break;
    }
    off += 8 + size + (size % 2);
  }
  return { sampleRate, channels, bits, samples };
}

function upsample(samples, factor) {
  if (factor <= 1) return samples;
  const out = new Array(samples.length * factor);
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[Math.min(i + 1, samples.length - 1)];
    for (let j = 0; j < factor; j++) out[i * factor + j] = Math.round(a + ((b - a) * j) / factor);
  }
  return out;
}

function designLowpass(cutoffHz, sampleRateHz, taps) {
  const half = (taps - 1) / 2;
  const fc = cutoffHz / sampleRateHz;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const t = n - half;
    const x = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1));
    h[n] = x * win;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

function lowpassFilter(samples, h) {
  const half = (h.length - 1) >> 1;
  const n = samples.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const start = i - half;
    for (let k = 0; k < h.length; k++) {
      const idx = start + k;
      if (idx >= 0 && idx < n) acc += samples[idx] * h[k];
    }
    out[i] = acc;
  }
  return out;
}

function downsample(samples, factor) {
  if (factor <= 1) return samples;
  const taps = Math.max(65, 2 * 16 * factor + 1);
  const filtered = lowpassFilter(
    samples,
    designLowpass(Math.round(0.45 * 8000), 8000 * factor, taps)
  );
  const n = Math.floor(samples.length / factor);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let v = Math.round(filtered[i * factor]);
    if (v < -32768) v = -32768;
    else if (v > 32767) v = 32767;
    out[i] = v;
  }
  return out;
}

function frameRms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = { pcmToBuffer, bufferToPcm, buildWavHeader, makeWav, parseWav, upsample, downsample, frameRms, chunk };