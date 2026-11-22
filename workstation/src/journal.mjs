// src/journal.mjs — append-only, hash-chained, and machine-checkable.
//
// The world tells you what happened. This tells you who asked for it, and under
// what governance. Two properties the gate will depend on:
//   1. a record's actor is stamped by the dispatcher, never claimed by the caller;
//   2. every byte that lands here is covered by a running hash, so a later edit
//      or a spliced-out line is detectable rather than silent.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './world.mjs';

const FILE = path.join(ROOT, 'journal.jsonl');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const canonical = (o) => {
  if (o === null || typeof o !== 'object') return JSON.stringify(o ?? null);
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',') + '}';
};

const chainOf = (row, prev) => sha(prev + '|' + canonical({ seq: row.seq, ts: row.ts, session: row.session, actor: row.actor, event: row.event, verb: row.verb, args: row.args, outcome: row.outcome, mode: row.mode }));

export async function init() {
  fs.mkdirSync(ROOT, { recursive: true });
  if (!fs.existsSync(FILE)) await fsp.writeFile(FILE, '');
}

export async function emit({ session, actor, event, verb = null, args = null, outcome = null, mode = 'passthrough' }) {
  const prev = ((await fsp.readFile(FILE, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).pop());
  const prevHash = prev ? JSON.parse(prev).hash : 'GENESIS';
  const seq = prev ? JSON.parse(prev).seq + 1 : 1;
  const row = { seq, ts: new Date().toISOString(), session, actor, event, verb, args, outcome, mode, prev: prevHash.slice(0, 16) };
  row.hash = chainOf(row, prevHash);
  await fsp.appendFile(FILE, JSON.stringify(row) + '\n');
  return row;
}

/** Recompute the chain from disk. Returns the first divergence, if any. */
export async function verify() {
  const lines = (await fsp.readFile(FILE, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  let prev = 'GENESIS';
  for (let i = 0; i < lines.length; i++) {
    const row = JSON.parse(lines[i]);
    if (row.seq !== i + 1) return { ok: false, at: row.seq, why: 'sequence gap (a line was removed)' };
    if (row.prev !== prev.slice(0, 16)) return { ok: false, at: row.seq, why: 'previous-hash mismatch (lines were reordered or spliced)' };
    if (chainOf(row, prev) !== row.hash) return { ok: false, at: row.seq, why: 'content does not match its own hash (a line was edited)' };
    prev = row.hash;
  }
  return { ok: true, rows: lines.length, head: prev.slice(0, 16) };
}

export async function recent(session, limit = 50) {
  const lines = (await fsp.readFile(FILE, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return (session ? lines.filter((l) => l.session === session) : lines).slice(-limit);
}
