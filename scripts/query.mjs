import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const rag = require('../lib/rag.js');

const q = process.argv.slice(2).join(' ').trim();
const k = 3;

if (!q) {
  console.error('usage: node scripts/query.mjs "what is Mrs Rao\'s blood pressure"');
  process.exit(1);
}

try {
  const hits = await rag.query(q, k);
  if (!hits.length) {
    console.log('NOT_FOUND: index empty or no match. Run node scripts/ingest.mjs docs first.');
    process.exit(0);
  }
  console.log(`top ${hits.length} chunks for: "${q}"\n`);
  hits.forEach((h, i) => {
    console.log(`[${i + 1}] score=${h.score.toFixed(3)}  source=${h.source}`);
    console.log(h.text.slice(0, 400));
    console.log();
  });
} catch (e) {
  console.error(`query failed: ${e.message}`);
  process.exit(1);
}