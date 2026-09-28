import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const rag = require('../lib/rag.js');

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1]) return fallback;
  const parsed = parseInt(args[i + 1], 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) || 'docs';
const chunk = argValue(args, '--chunk', 700);
const overlap = argValue(args, '--overlap', 100);
const outI = args.indexOf('--out');
const out = outI !== -1 && args[outI + 1] ? args[outI + 1] : 'data/index.json';

try {
  const idx = await rag.ingestDir(dir, { chunk, overlap, out });
  console.log(`\nDone: ${idx.entries.length} chunks indexed (dim=${idx.dim}) -> ${out}`);
} catch (e) {
  console.error(`ingest failed: ${e.message}`);
  process.exit(1);
}