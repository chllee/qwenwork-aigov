// src/policy.mjs — the decision table, plus the obligations mined out of prose.
//
// Specificity order for `state a fact`: an obligation written into a client
// contract outranks the owner's general policy, which outranks the default. The
// oversight layer keeps every rule it consulted, because the rule SET is the
// explanation — S2 is a floor breach and a discount at the same time.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { obligations } from './facts.mjs';
import { rankOf } from './classify.mjs';

export const DECISION = { ALLOW: 'ALLOW', APPROVE: 'HOLD_FOR_APPROVAL', NEVER: 'BLOCK' };
/** policy wording (ALLOW / APPROVE / NEVER) -> the outcome vocabulary the kit scores against */
export const TO_OUTCOME = { ALLOW: 'ALLOW', APPROVE: 'HOLD_FOR_APPROVAL', NEVER: 'BLOCK' };
const SEVERITY = { BLOCK: 3, HOLD_FOR_APPROVAL: 2, ALLOW: 1 };
export const worst = (list) => list.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'ALLOW');

// ---- external parties ------------------------------------------------------
export const EXTERNAL_TOOLS = {
  'sparkmail.example': { name: 'SparkMail', retains_data: true, category: 'newsletter' },
  'notion.so': { name: 'Notion', retains_data: true, category: 'docs' },
  'chatgpt.com': { name: 'ChatGPT', retains_data: true, category: 'ai' },
  'grammarly.com': { name: 'Grammarly', retains_data: false, category: 'writing' },
};

export async function loadPolicy(db, rootDir) {
  const file = path.join(rootDir, 'rules', 'policy.json');
  const raw = readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);
  const sha = createHash('sha256').update(raw).digest('hex');
  await db.query(
    `insert into policy_versions(version,source_sha256,rule_count,raw) values($1,$2,$3,$4::jsonb)
     on conflict(version) do update set source_sha256=excluded.source_sha256, rule_count=excluded.rule_count, raw=excluded.raw`,
    [doc.version, sha, doc.rules.length, raw]);
  return { ...doc, sha };
}

/** Roster of who is who, built from the business's own records. */
export async function buildRoster(db, rootDir) {
  const read = (p) => { try { return readFileSync(path.join(rootDir, 'data', p), 'utf8'); } catch { return ''; } };
  const csv = read('admin/client_list.csv');
  const clients = csv.split('\n').slice(1).map((l) => l.split(',')[0]?.trim()).filter((n) => n && n !== 'client');
  const emails = {};
  csv.split('\n').slice(1).forEach((l) => { const c = l.split(','); if (c[0] && c[2]) emails[c[2].trim()] = c[0].trim(); });
  const supTxt = read('admin/supplier_list.md');
  const suppliers = [...supTxt.matchAll(/^-\s*([A-Z][A-Za-z ]+?)\s*(?:\(|·|,)/gm)].map((m) => m[1].trim());
  const supDomains = {};
  for (const m of supTxt.matchAll(/([a-z0-9.-]+)\.(example|com)/gi)) supDomains[m[0].toLowerCase()] = true;
  return {
    clients, emails,
    suppliers: [...new Set(suppliers.concat(['QuickPrint', 'Ferro Logistics', 'Nimbus Health', 'Harbourbean Coffee']))],
    isClient(n) { return this.clients.some((c) => n && (c.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(c.toLowerCase()))); },
    isSupplier(n) { return this.suppliers.some((c) => n && c.toLowerCase().includes(n.toLowerCase())); },
    domainOf(addr) { return String(addr || '').split('@')[1]?.toLowerCase() ?? ''; },
    partyFor(addr) {
      const d = this.domainOf(addr);
      for (const [e, c] of Object.entries(emails)) if (e.toLowerCase() === String(addr).toLowerCase()) return { name: c, kind: 'client' };
      if (Object.keys(supDomains).some((s) => s.includes(d))) return { name: d, kind: 'supplier' };
      if (this.isClient(d.split('.')[0])) return { name: d, kind: 'client' };
      if (d === 'lumenstudio.example') return { name: 'owner', kind: 'self' };
      return { name: d || addr, kind: 'unknown' };
    },
  };
}

/**
 * Least-privilege read model.
 *  - regulated data is readable only when a human NAMED it for this task;
 *    never because an agent found it.
 *  - client-confidential data is readable when the task is about that client.
 *  - everything else is allowed, and unrelated reads are recorded as scope creep.
 */
export function readNeed(task, file, roster) {
  const declared = (task.scope?.files ?? []).map((f) => f.toLowerCase());
  const lvl = file.derived_level;
  if (declared.includes(file.path.toLowerCase())) return { needed: true, why: 'named in the task scope by the owner', basis: 'declared' };
  if (rankOf(lvl) >= rankOf('regulated')) return { needed: false, why: 'regulated data was not named in the task scope', basis: 'default-deny' };
  if (rankOf(lvl) >= rankOf('client-confidential')) {
    const about = (task.scope?.clients ?? []).some((c) => roster.isClient(c) && file.textContains?.(c))
      || (task.scope?.clients ?? []).some((c) => String(c).toLowerCase().split(' ')[0] && file.path.toLowerCase().includes(String(c).toLowerCase().split(' ')[0]));
    return about
      ? { needed: true, why: `task concerns ${task.scope.clients.join(', ')}`, basis: 'client-match' }
      : { needed: false, why: 'client-confidential, unrelated to the client this task is about', basis: 'client-mismatch', related: true };
  }
  const touches = (task.scope?.keywords ?? []).some((k) => String(k).toLowerCase() && file.path.toLowerCase().includes(String(k).toLowerCase()));
  return { needed: true, why: touches ? 'internal material referenced by the task' : 'low-sensitivity working information', basis: 'low-risk', inScope: touches };
}

export async function relatedObligations(db, { client = null, kind = null } = {}) {
  const where = [], vals = [];
  if (kind) { vals.push(kind); where.push(`kind = $${vals.length}`); }
  const rows = await obligations(db);
  return rows.filter((o) => {
    if (kind && o.kind !== kind) return false;
    if (!client) return true;
    const c = String(client).toLowerCase();
    const hay = (`${o.source_path} ${o.source_quote} ${JSON.stringify(o.params)}`).toLowerCase();
    return c.split(/\s+/).some((tok) => tok.length > 3 && hay.includes(tok));
  });
}
