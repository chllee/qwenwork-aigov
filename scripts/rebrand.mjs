#!/usr/bin/env node
// scripts/rebrand.mjs — rename the PRODUCT without touching the EVIDENCE.
//
// Why this exists instead of sed: a rebrand has to be exact in both directions.
//  - it must fail loudly when a pattern isn't found (silent no-op is what a
//    multi-pattern `sed -i ''` does on BSD), and
//  - it must refuse to touch strings that are load-bearing test fixtures.
//
// `Lumen Studio` is AvePoint's fictional company. Its name appears inside the
// invoices, contracts and policy the gate reads, and in three regexes that derive
// classification floors from that text. Renaming those would silently change
// behaviour and is the exact edit no one notices until 15/15 has become 9/15.

import { readFileSync, writeFileSync } from 'node:fs';

/** [file, [[from, to], ...]] */
const EDITS = [
  ['web/index.html', [
    ['<title>Lumen — what your AI did</title>', '<title>Kagi 鍵 — what your AI did</title>'],
    ['<h1>Lumen <span>· oversight for a one-person company</span></h1>',
     '<h1>Kagi <span>· 鍵 · the key your agents must turn</span></h1>'],
  ]],
  ['src/server.mjs', [['`Lumen oversight console →', '`Kagi console →']]],
  ['src/log.mjs', [["'lumen-demo-key'", "'kagi-demo-key'"]]],
  ['mcp/server.mjs', [
    ["name: 'lumen-oversight-gate'", "name: 'kagi-gate'"],
    ['`lumen oversight gate · mcp stdio', '`Kagi gate · mcp stdio'],
  ]],
  ['db/migrations/001_init.sql', [['Lumen oversight layer', 'Kagi oversight layer']]],
  ['package.json', [
    ['"name": "qwenwork-aigov"', '"name": "kagi-gate"'],
    ['"description": "An oversight layer for one-person companies: every agent action is logged, gated and explained to the owner"',
     '"description": "Kagi — an oversight layer for one-person companies: every agent action is logged, gated and explained to the owner"'],
  ]],
];

/** Never searched, never rewritten: fixture text and derived output. */
const PROTECTED = [
  'data/', 'rules/', 'out/', 'demo/scenarios_extra.json',
  'src/classify.mjs', 'src/policy.mjs', // regexes matching Lumen Studio's own documents
];

let applied = 0, missing = [];
for (const [f, subs] of EDITS) {
  let txt;
  try { txt = readFileSync(f, 'utf8'); }
  catch { missing.push(`${f}: unreadable`); continue; }
  for (const [from, to] of subs) {
    if (!txt.includes(from)) { missing.push(`${f}: pattern not found → ${from.slice(0, 58)}`); continue; }
    txt = txt.split(from).join(to); applied++;
  }
  writeFileSync(f, txt);
}

// what must survive, verbatim
const mustSurvive = [
  ['src/classify.mjs', 'lumen studio · invoice'],
  ['src/classify.mjs', 'about (?:us|lumen)'],
  ['src/policy.mjs', 'lumenstudio.example'],
];
let kept = 0, lost = [];
for (const [f, needle] of mustSurvive) {
  const t = readFileSync(f, 'utf8');
  if (t.includes(needle)) kept++; else lost.push(`${f}: lost fixture pattern "${needle}"`);
}

console.log(`rebrand: ${applied} edit(s) applied, ${kept}/${mustSurvive.length} fixture patterns preserved`);
if (missing.length || lost.length) {
  for (const m of missing) console.log('  MISSING  ' + m);
  for (const l of lost) console.log('  DAMAGED  ' + l);
  console.log('\nNothing was verified. Fix the above, then run:  npm run reseed');
  process.exit(1);
}
console.log('OK — now prove the gate still behaves:  npm run reseed');
