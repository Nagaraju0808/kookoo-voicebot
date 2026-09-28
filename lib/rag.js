const fs = require('fs');
const path = require('path');

const MODEL = process.env.RAG_EMBED_MODEL || 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_OUT = process.env.RAG_INDEX || 'data/index.json';

let _pipeline = null;
let _loading = null;

async function getPipeline() {
  if (_pipeline) return _pipeline;
  if (!_loading) {
    _loading = (async () => {
      const mod = await import('@huggingface/transformers');
      const pipeline = mod.pipeline || mod.default?.pipeline || mod.default;
      if (typeof pipeline !== 'function') {
        throw new Error('transformers.js pipeline not found — load via await import(), never require()');
      }
      _pipeline = await pipeline('feature-extraction', MODEL, { quantized: true });
      return _pipeline;
    })().catch((e) => {
      _loading = null;
      throw e;
    });
  }
  return _loading;
}

async function init() {
  await getPipeline();
  return true;
}

async function embed(texts) {
  const p = await getPipeline();
  const out = await p(Array.isArray(texts) ? texts : [texts], {
    pooling: 'mean',
    normalize: true,
  });
  const list = typeof out.tolist === 'function' ? out.tolist() : out.data ?? out;
  return Array.isArray(list) && Array.isArray(list[0]) ? list : [list];
}

function chunkText(text, chunkSize = 700, overlap = 100) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  const step = Math.max(chunkSize - overlap, 50);
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(' ', end);
      if (lastSpace > start) end = lastSpace;
    }
    const c = clean.slice(start, end).trim();
    if (c) chunks.push(c);
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

async function fileToText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.txt' || ext === '.md') return fs.readFileSync(file, 'utf8');
  if (ext === '.pdf') {
    const mod = await import('pdf-parse');
    if (typeof mod.PDFParse === 'function') {
      const inst = new mod.PDFParse({ data: fs.readFileSync(file) });
      const res = await inst.getText();
      return res && res.text ? res.text : '';
    }
    const pdfParse = mod.default || mod;
    const data = await pdfParse(fs.readFileSync(file));
    return data && data.text ? data.text : '';
  }
  if (ext === '.docx') {
    const mammoth = (await import('mammoth'));
    const res = await mammoth.extractRawText({ buffer: fs.readFileSync(file) });
    return res && res.value ? res.value : '';
  }
  return null;
}

async function ingestDir(dir, { chunk = 700, overlap = 100, out = DEFAULT_OUT } = {}) {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .map((d) => path.join(dir, d.name))
    .filter((f) => fs.statSync(f).isFile());
  const entries = [];
  for (const f of files) {
    const text = await fileToText(f);
    if (!text || !text.trim()) {
      console.log(`skip (no text): ${path.basename(f)}`);
      continue;
    }
    const chunks = chunkText(text, chunk, overlap);
    console.log(`  ${path.basename(f)}: ${chunks.length} chunks`);
    for (const t of chunks) entries.push({ source: path.basename(f), text: t });
  }
  if (!entries.length) throw new Error(`no parseable documents found in ${dir}`);
  console.log(`embedding ${entries.length} chunks with ${MODEL}...`);
  const vectors = await embed(entries.map((e) => e.text));
  const index = {
    model: MODEL,
    dim: vectors[0].length,
    chunk,
    overlap,
    updatedAt: new Date().toISOString(),
    entries: entries.map((e, i) => ({ source: e.source, text: e.text, vector: vectors[i] })),
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(index));
  return index;
}

function loadIndex(out = DEFAULT_OUT) {
  if (!fs.existsSync(out)) return null;
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

const MIN_SCORE = parseFloat(process.env.RAG_MIN_SCORE || '0.25');
const DEFAULT_K = parseInt(process.env.RAG_TOP_K || '5', 10);

function normalizeQuery(q) {
  return q
    .toLowerCase()
    .replace(/\bbp\b/g, 'blood pressure')
    .replace(/\bmeds?\b/g, 'medicines')
    .replace(/\ballerg\w*/g, 'allergies')
    .replace(/\bappt\w*/g, 'appointment')
    .replace(/\bdr\.?\b/g, 'doctor')
    .replace(/\bprescrip\w*/g, 'prescription')
    .replace(/\brefill\w*/g, 'refill')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function query(q, k = DEFAULT_K, out = DEFAULT_OUT) {
  const idx = loadIndex(out);
  if (!idx || !idx.entries || !idx.entries.length) return [];
  const normalized = normalizeQuery(q);
  const [qv] = Array.isArray(normalized) ? normalized : await embed([normalized]);
  return idx.entries
    .map((e) => {
      let s = 0;
      for (let i = 0; i < qv.length; i++) s += qv[i] * e.vector[i];
      return { source: e.source, text: e.text, score: s };
    })
    .sort((a, b) => b.score - a.score)
    .filter((r) => r.score >= MIN_SCORE)
    .slice(0, k)
    .map(({ source, text, score }) => ({ source, text, score }));
}

function retrievalResult(chunks) {
  if (!chunks || !chunks.length) {
    return (
      'NOT_FOUND: no record matched this query in the local index. ' +
      'Tell the caller you could not find that information and offer to ' +
      'connect them to the front desk. Do not guess.'
    );
  }
  const context = chunks
    .map((c, i) => `[${i + 1}] score=${c.score.toFixed(3)} (${c.source}) ${c.text}`)
    .join('\n\n');
  return (
    'Relevant records found. Answer ONLY from this context. If the context does not ' +
    'answer the question, treat it as NOT_FOUND:\n\n' + context
  );
}

module.exports = { init, embed, chunkText, ingestDir, loadIndex, query, retrievalResult, MODEL };