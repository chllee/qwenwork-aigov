import { openDb } from '../src/log.mjs';
import { ingest } from '../src/classify.mjs';
import { extractAll, mineObligations } from '../src/facts.mjs';
import { loadDataFiles } from '../src/fsio.mjs';

const db = await openDb();
await ingest(db, async () => loadDataFiles());
const nf = await extractAll(db);
const ob = await mineObligations(db);

console.log(`\nfacts indexed: ${nf} across ${new Set((await db.query('select path from facts')).rows.map((r) => r.path)).size} files`);
console.log('sample of the figures the Ferro dispute turns on:');
for (const v of [20, 25, 4200, 5040, 5250, 840, 24, 2, 5, 30]) {
  const rows = (await db.query(`select path,locator,field,raw,unit from facts where value=$1 order by path limit 3`, [v])).rows;
  console.log(`  ${String(v).padEnd(6)} ${rows.length ? rows.map((r) => `${r.path.split('/').pop()}@${r.locator}${r.field ? ' {' + r.field.slice(0, 22) + '}' : ''}`).join(' | ') : 'ABSENT FROM EVERY FILE'}`);
}
console.log(`\nobligations mined from prose: ${ob.length}`);
for (const r of (await db.query('select id,kind,source_path,source_quote,params from obligations order by kind')).rows) {
  console.log(`  [${r.kind}] ${r.source_path} :: "${r.source_quote.slice(0, 74)}"`);
  console.log(`      ${JSON.stringify(r.params)}`);
}
console.log();
await db.close();
