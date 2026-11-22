// src/log.mjs — the single logged channel.
// Everything that happens in the system is one append-only, hash-chained event.
// Agents submit intent; they do not write prose about what they did.

import { PGlite } from '@electric-sql/pglite';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = process.env.PGLITE_DIR || path.join(ROOT, '.pgdata');

export const LEVELS = { public: 0, internal: 1, 'client-confidential': 2, regulated: 3 };

export async function openDb() {
  const db = await PGlite.create(DATA_DIR);
  const dir = path.join(ROOT, 'db', 'migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(path.join(dir, f), 'utf8'));
  }
  return db;
}

// deterministic serialisation so a chain can be re-verified byte for byte
export function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj ?? null);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

const HASHED_COLS = [
  'id', 'ts', 'run_id', 'actor', 'actor_kind', 'kind', 'action', 'data_level',
  'policy_version', 'rules', 'evidence', 'decision', 'reason', 'payload', 'approval_for',
];

export function rowHash(row, prevHash) {
  const body = canonical(Object.fromEntries(HASHED_COLS.map((c) => [c, row[c]])));
  return sha256(prevHash + '|' + body);
}
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * Append one event. This is the ONLY write path into the ledger.
 * `actor` is stamped by the caller's authenticated principal, never claimed
 * inside the payload — an agent cannot assert it was the human.
 */
export async function append(db, ev) {
  const prev = await db.query('select hash as h from events order by seq desc limit 1');
  const prevHash = prev.rows[0]?.h ?? 'GENESIS';
  const row = {
    id: ev.id ?? ('ev_' + sha256(prevHash + canonical(ev)).slice(0, 20)),
    ts: ev.ts ?? new Date().toISOString(),
    run_id: ev.run_id ?? null,
    actor: ev.actor,
    actor_kind: ev.actor_kind,
    kind: ev.kind,
    action: ev.action ?? null,
    data_level: ev.data_level ?? null,
    policy_version: ev.policy_version ?? null,
    rules: ev.rules ?? null,
    evidence: ev.evidence ?? null,
    decision: ev.decision ?? null,
    reason: ev.reason ?? null,
    payload: ev.payload ?? null,
    approval_for: ev.approval_for ?? null,
  };
  const hash = rowHash(row, prevHash);
  const res = await db.query(
    `insert into events(id,ts,run_id,actor,actor_kind,kind,action,data_level,policy_version,
       rules,evidence,decision,reason,payload,approval_for,hash,prev_hash)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14::jsonb,$15,$16,$17)
     returning seq`,
    [row.id, row.ts, row.run_id, row.actor, row.actor_kind, row.kind, row.action, row.data_level,
     row.policy_version, j(row.rules), j(row.evidence), row.decision, row.reason, j(row.payload),
     row.approval_for, hash, prevHash]
  );
  return { seq: res.rows[0].seq, ...row, hash, prev_hash: prevHash };
}

export async function ledger(db, { runId, kind, limit = 500 } = {}) {
  const where = [], vals = [];
  if (runId) { vals.push(runId); where.push(`run_id = $${vals.length}`); }
  if (kind) { vals.push(kind); where.push(`kind = $${vals.length}`); }
  const res = await db.query(
    `select * from events ${where.length ? 'where ' + where.join(' and ') : ''}
     order by seq asc limit ${Number(limit) | 0}`, vals);
  return res.rows;
}

/** Recompute every hash from row 1. Proves nothing was edited, spliced or truncated. */
export async function verifyChain(db) {
  const rows = (await db.query('select * from events order by seq asc')).rows;
  let prev = 'GENESIS';
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, checked: rows.length, brokenAt: r.seq, why: 'prev_hash mismatch (splice or delete)' };
    for (const c of HASHED_COLS) {
      if (typeof r[c] === 'object' && r[c] !== null) r[c] = JSON.parse(typeof r[c] === 'string' ? r[c] : JSON.stringify(r[c]));
    }
    if (rowHash(r, prev) !== r.hash) return { ok: false, checked: rows.length, brokenAt: r.seq, why: 'row content does not match its hash (edit)' };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, head: prev };
}

/** HMAC attestation of the ledger head, exported after every run. */
export async function seal(db, outDir = path.join(ROOT, 'attestations')) {
  const rows = (await db.query('select count(*) n, max(hash) h from events')).rows[0];
  const key = process.env.ATTEST_KEY || 'lumen-demo-key';
  const body = canonical({ n: Number(rows.n), head: rows.h, at: new Date().toISOString(), run: 'seal' });
  const sig = createHmac('sha256', key).update(body).digest('hex');
  const doc = { ...JSON.parse(body), sig, verify: 'hmac-sha256(ATTEST_KEY, canonical({n,head,at,run}))' };
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `ledger-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return { file, ...doc };
}
