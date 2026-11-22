import { openDb } from '../src/log.mjs';
import { buildBriefing } from '../src/briefing.mjs';
import { writeFileSync } from 'node:fs';
import { ROOT_DIR } from '../src/fsio.mjs';
const db = await openDb();
const runId = process.argv[2] || (await db.query(`select run_id from events where kind='verdict' order by seq desc limit 1`)).rows[0]?.run_id;
const b = await buildBriefing(db, runId);
const line = '─'.repeat(72);
console.log(`\n${line}\n  MORNING BRIEFING for Mei Tan · run ${runId}\n${line}\n`);
for (const l of b.lines) {
  const tag = l.who === 'headline' ? '◆' : l.who === 'summary' ? '▣' : '·';
  const who = ['headline', 'summary', 'oversight', 'mei.tan'].includes(l.who) ? '' : `${l.who.charAt(0).toUpperCase()}${l.who.slice(1)} `;
  console.log(`  ${tag}  ${who}${l.text.charAt(0).toUpperCase() + l.text.slice(1)}\n`);
}
console.log(`${line}\n  60-SECOND SCRIPT (${b.script.words} words ≈ ${b.script.seconds}s)\n${line}\n`);
const wrap = (t, w = 74) => t.split(/\s+/).reduce((a, word) => { const last = a[a.length - 1]; if (last && (last + ' ' + word).length <= w) a[a.length - 1] = last + ' ' + word; else a.push(word); return a; }, []).join('\n');
console.log(wrap(b.script.text).split('\n').map((l) => '  ' + l).join('\n') + '\n');
writeFileSync(`${ROOT_DIR}/out/briefing-${runId}.json`, JSON.stringify(b, null, 2));
await db.close();
