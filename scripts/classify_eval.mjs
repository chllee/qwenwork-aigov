import { openDb } from '../src/log.mjs';
import { ingest } from '../src/classify.mjs';
import { loadDataFiles, groundTruth } from '../src/fsio.mjs';

const TRAPS = {
  'inbox/2026-11-13_nimbus_patient_data_in_error.md': ' mundane client email hides patient data -> regulated',
  'clients/proposal_ferro_logistics.md': ' contains a non-public fundraising figure -> client-confidential',
  'finance/cashflow_notes_nov2026.md': " owner's own money -> regulated, not internal",
  'marketing/case_study_harbourbean.md': ' names a client but is approved for publication -> public',
};

const db = await openDb();
const results = await ingest(db, async () => loadDataFiles());
const gt = groundTruth();

const rows = results.map((r) => ({ ...r, truth: gt[r.path] ?? null })).filter((r) => r.truth);
const ok = rows.filter((r) => r.derived === r.truth);
console.log(`\nclassifier vs ground truth: ${ok.length}/${rows.length} = ${(100 * ok.length / rows.length).toFixed(1)}%`);

const bad = rows.filter((r) => r.derived !== r.truth);
if (bad.length) {
  console.log(`\n--- ${bad.length} miss${bad.length > 1 ? 'es' : ''} ---`);
  for (const b of bad) {
    console.log(`\n  ${b.path}\n    truth=${b.truth}  derived=${b.derived}`);
    const top = b.signals.filter((s) => s.rank >= 0).slice(0, 4);
    for (const s of top) console.log(`      fired: [${s.level}] ${s.why} @ ${s.where}`);
    if (!top.length) console.log('      fired: (nothing)');
  }
}

console.log('\n--- AvePoint\'s four declared traps ---');
for (const [p, note] of Object.entries(TRAPS)) {
  const r = rows.find((x) => x.path === p);
  console.log(`  ${r && r.derived === r.truth ? 'PASS' : 'FAIL'}  ${p.split('/').pop()}${note}  (got ${r?.derived})`);
}

const per = {};
for (const r of rows) {
  per[r.truth] ??= { n: 0, ok: 0 };
  per[r.truth].n++; if (r.derived === r.truth) per[r.truth].ok++;
}
console.log('\n--- by level ---');
for (const [l, v] of Object.entries(per)) console.log(`  ${l.padEnd(20)} ${v.ok}/${v.n}`);
console.log();
await db.close();
