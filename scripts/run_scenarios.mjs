import { boot, newRunId, announce } from '../src/boot.mjs';
import { replay, pointsOf } from '../src/replay.mjs';
import { ledger, verifyChain, seal } from '../src/log.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { ROOT_DIR } from '../src/fsio.mjs';

const ONLY_KIT = process.env.EXTRAS === '0';
const { db, policy, roster, scenarios, disagreements } = await boot();
const kit = scenarios.filter((s) => !s.our_own);
const ours = scenarios.filter((s) => !s.our_own === false && s.our_own);
const pack = ONLY_KIT ? kit : kit.concat(ours);

const runId = newRunId();
await announce(db, runId, policy, roster, 'cli');
if (disagreements.length) console.log(`\nlabel channel: ${disagreements.length} file(s) disagree with their own header — recorded before any action ran:\n  ${disagreements.map((d) => `${d.path} (declares ${d.declared}, content is ${d.derived})`).join('\n  ')}`);

const scored = await replay(db, { policy, roster, runId, scenarios: pack });
const line = '═'.repeat(74);
console.log(`\n${line}\n  AVEPOINT SCENARIO PACK — self-scored their way: decision / rule / evidence\n${line}`);
for (const r of scored) {
  const m = (b) => (b ? 'PASS' : 'FAIL');
  console.log(`\n${r.sc.id} · ${r.sc.name}${r.sc.our_own ? '  (our own)' : ''}   expected ${r.sc.expected_oversight.decision}`);
  console.log(`   decision ${m(r.score.decision.ok)}  got=${r.score.decision.got} want=${r.score.decision.want}`);
  console.log(`   rules    ${m(r.score.rules.ok)}  want={${r.score.rules.want}} got={${r.score.rules.got}}`);
  console.log(`   evidence ${m(r.score.evidence.ok)}  files ${r.score.evidence.paths} [${r.score.evidence.hits}] kw ${r.score.evidence.kw}`);
  if (!r.score.rules.ok) console.log(`      missing rules: ${r.score.rules.miss}`);
  if (!r.score.evidence.ok) console.log(`      missing cites: ${r.score.evidence.miss} | kw: ${r.score.evidence.kwMiss.slice(0, 8)}`);
  for (const o of r.outcomes.filter((x) => x.decision)) console.log(`      · ${o.decision.padEnd(18)} ${(o.rules ?? []).join('+').padEnd(18)} ${String(o.step).slice(0, 54)}`);
}
const pts = pointsOf(scored);
const ownPts = scored.filter((r) => r.sc.our_own).reduce((n, r) => n + ['decision', 'rules', 'evidence'].filter((k) => r.score[k].ok).length, 0);
console.log(`\n>>> AVEPOINT'S FIVE: ${pts}/15${pts === 15 ? '  — zero missed violations' : ''}`);
if (scored.some((r) => r.sc.our_own)) console.log(`>>> OUR OWN SCENARIOS: ${ownPts}/${scored.filter((r) => r.sc.our_own).length * 3}`);
const chain = await verifyChain(db);
const manifest = await seal(db);
console.log(`ledger: ${chain.checked} events, integrity ${chain.ok ? 'VERIFIED' : 'BROKEN: ' + chain.why} · attestation ${manifest.file.split('/').pop()}`);
console.log(`run id: ${runId}   →  npm run briefing -- ${runId}\n`);
mkdirSync(ROOT_DIR + '/out', { recursive: true });
writeFileSync(ROOT_DIR + '/out/last_run.json', JSON.stringify({ runId, pts, ownPts, chain, manifest, scored }, null, 2));
await db.close();
