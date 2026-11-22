// src/boot.mjs — open the database and bring the world up to date.
import { openDb, append } from './log.mjs';
import { ingest, logDisagreements } from './classify.mjs';
import { extractAll, mineObligations } from './facts.mjs';
import { loadPolicy, buildRoster } from './policy.mjs';
import { resetProvenanceCache } from './provenance.mjs';
import { loadDataFiles, readRule, ROOT_DIR } from './fsio.mjs';
import { existsSync, readFileSync } from 'node:fs';

export async function boot({ fresh = false } = {}) {
  const db = await openDb();
  const files = await ingest(db, async () => loadDataFiles());
  await extractAll(db);
  await mineObligations(db);
  resetProvenanceCache();
  const policy = await loadPolicy(db, ROOT_DIR);
  const roster = await buildRoster(db, ROOT_DIR);
  const disagreements = await logDisagreements(db, files, 'inventory');
  const scenarios = readRule('scenarios.json').concat(
    existsSync(ROOT_DIR + '/demo/scenarios_extra.json') ? JSON.parse(readFileSync(ROOT_DIR + '/demo/scenarios_extra.json', 'utf8')) : []);
  return { db, files, policy, roster, scenarios, disagreements };
}
export const newRunId = (tag = 'run') => `${tag}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
export async function announce(db, runId, policy, roster, channel) {
  return append(db, {
    run_id: runId, actor: 'system', actor_kind: 'system', kind: 'note',
    reason: `run started · policy v${policy.version} (${policy.sha.slice(0, 12)}) · ${policy.rules.length} rules · roster of ${roster.clients.length} clients and ${roster.suppliers.length} suppliers · channel ${channel}`,
  });
}
