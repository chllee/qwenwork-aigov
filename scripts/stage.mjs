// scripts/stage.mjs — a CLI for the same staging the console does, for demos and CI.
//
// AvePoint's 27 files are the world's *content*: they enter through the ordinary upload
// path, exactly as a human's files would. They are never read by the product at runtime,
// never imported by the gate or the scorer, and the labels the kit ships alongside them
// stay out of the build entirely.
import fsp from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const ACTOR = process.env.UPLOADER || 'mei.tan';

// searched in order; first existing wins. no absolute machine paths in the repo.
const CANDIDATES = [process.env.CORPUS, process.env.KAGI_CORPUS, 'corpus', '../corpus', '../uploads', '../kagi-starter-pack/data']
  .filter(Boolean).map((d) => path.resolve(d));

async function upload(rel, buf) {
  const r = await fetch(`${BASE}/api/upload?path=${encodeURIComponent('docs/' + rel)}`, {
    method: 'POST', headers: { 'x-upload-actor': ACTOR }, body: buf });
  if (!r.ok) throw Object.assign(new Error(`upload ${rel} → HTTP ${r.status}`), { detail: await r.text().catch(() => '') });
  return r.json();
}

let SRC;
for (const c of CANDIDATES) { try { await fsp.access(c); SRC = c; break; } catch { /* next */ } }
if (!SRC) {
  console.error(`\n  no corpus found. looked in:\n    ${CANDIDATES.join('\n    ')}` +
    `\n\n  fix:  CORPUS=/path/to/starter-pack/data node scripts/stage.mjs\n        (or drop the kit's data folder next to this repo and name it 'corpus')\n`);
  process.exit(2);
}

const found = [];
const walk = async (dir, pre = '') => {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = pre ? `${pre}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') await walk(full, rel); }
    else if (/\.(md|csv|txt)$/.test(e.name)) found.push([rel, await fsp.readFile(full)]);
  }
};
await walk(SRC);

// refuse anything that would not survive the server's own path rules, so failures here
// are loud and local instead of a confusing 400 per file
// identity comparison on freshly built arrays never matches, so key on the path string
const reject = new Set(found.filter(([rel]) => /\0|\\|\.\./.test(rel) || rel.length > 160).map(([rel]) => rel));
const good = found.filter(([rel]) => !reject.has(rel));
const skip = [...reject];

console.log(`\n  staging ${good.length} files from ${SRC} as ${ACTOR} → ${BASE}`);
let bytes = 0, done = 0;
for (const [rel, buf] of good) {
  try { const r = await upload(rel, buf); bytes += r.bytes; done++; }
  catch (e) { console.log(`    ✘ ${rel}: ${e.message} ${e.detail || ''}`); }
}
console.log(`  done: ${done}/${good.length} files, ${bytes} bytes recorded in world.json`);
if (skip.length) console.log(`  skipped ${skip.length} path(s) that break the world's rules: ${skip.slice(0,3).join(', ')}`)
console.log();
process.exit(done === good.length ? 0 : 1);
