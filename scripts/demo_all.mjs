// The whole story in one command: label the corpus, prove the classifier, run the
// rogue-agent pack, then read what the owner would read.
import { spawnSync } from 'node:child_process';
const run = (s) => { const r = spawnSync('node', s.split(' '), { stdio: 'inherit' }); if (r.status) process.exit(r.status ?? 1); };
console.log('\n▸ 1. classify 28 files, header-blind, score against the answer key');
run('scripts/classify_eval.mjs');
console.log('▸ 2. run AvePoint five + ours through the gate');
run('scripts/run_scenarios.mjs');
const runId = process.env.RUN_ID;
console.log('▸ 3. the morning briefing the owner reads');
run('scripts/briefing.mjs' + (runId ? ' ' + runId : ''));
