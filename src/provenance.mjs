// src/provenance.mjs — is every figure in the output actually in the evidence?
//
// AvePoint's brief: "Check the agent's numbers against the evidence it had."
// Four verdicts per figure, each citable to a file and a line:
//   supported     the value appears in a file that governs this client
//   contradiction a governing document states a different value for the same field
//   derived       the value exists only as arithmetic over other values
//   unsupported   no file in the business contains it
// Matching is client-scoped and unit-typed on purpose: a coincidental 5 in an
// unrelated file is not support for "the deadline moved by 5 days".

import { extractFromText } from './facts.mjs';
import { rankOf } from './classify.mjs';
import { LEVELS } from './log.mjs';

export const norm = (s) => String(s || '').toLowerCase()
  .replace(/\b(?:the|our|per|a|an|and|of|is|are|at|to|for|from|by|on|it|its|in|as|be|has|have|was|were)\b/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter((t) => t.length > 3 && !/^\d+$/.test(t)));
export const overlap = (a, b) => { const A = tokens(a), B = tokens(b); let n = 0; for (const t of A) if (B.has(t)) n++; return n; };

const CLS = { pct: 'pct', days: 'days', units: 'count', SGD: 'money', amount: 'money', num: 'money', month: 'date' };
export const unitCls = (u) => CLS[u] ?? 'money';

/** does this fact belong to the client whose email we are checking? */
const scopes = (r, client) => {
  if (!client) return true;
  const key = String(client).toLowerCase().split(' ')[0];
  if (!key || key.length < 4) return true;
  return (`${r.path} ${r.context}`).toLowerCase().includes(key);
};

/** the noun phrase a figure is about: surcharge, total, deadline, receivables... */
/** the words a figure is about, strongest first: the one sitting right before it */
export function headTokens(claim) {
  const ctx = String(claim.context ?? '');
  const at = ctx.toLowerCase().indexOf(String(claim.raw ?? '').toLowerCase());
  const before = at > 0 ? ctx.slice(0, at) : ctx;
  const keep = (w) => w.length >= 4 && !/^(draft|stands|reads|states|says|noted|applies|moves|when|any)$/.test(w);
  const ws = [...new Set(norm(before).split(' ').filter(keep))];
  return { all: ws.slice(-3), primary: ws[ws.length - 1] ?? null, secondary: ws[ws.length - 2] ?? null };
}

/** Extract every claim (figure, date, quantity) from a draft, with locators. */
export function claimsIn(text) {
  return extractFromText('draft', text)
    .filter((f) => f.unit !== 'num' || Number(f.value) >= 100)   // ignore trivia
    .map((f, i) => ({ ...f, claimId: 'c' + (i + 1) }));
}

let _rows = null;
export function resetProvenanceCache() { _rows = null; }
async function allRows(db) {
  if (_rows) return _rows;
  _rows = (await db.query(`select f.path,f.locator,f.field,f.raw,f.value,f.unit,f.context,c.derived_level
    from facts f join files c on c.path = f.path where f.value is not null`)).rows;
  return _rows;
}

// the word immediately before the number is the real field label: it decides ties
const headHits = (r, heads) => {
  const t = norm((r.field ?? '') + ' ' + r.context);
  let n = heads.all.reduce((a, h) => a + (t.includes(h) ? 1 : 0), 0);
  if (heads.primary && t.includes(heads.primary)) n += 4;
  else if (heads.secondary && t.includes(heads.secondary)) n += 3;
  return n;
};

/** Is this value an arithmetic result over money values in the corpus? */
function deriveFrom(rows, target) {
  const m = rows.filter((r) => unitCls(r.unit) === 'money' && Number(r.value) > 0);
  for (let i = 0; i < m.length; i++) {
    for (let j = i; j < m.length; j++) {
      if (Math.abs(Number(m[i].value) + Number(m[j].value) - target) < 0.01) {
        return {
          formula: `${m[i].value} + ${m[j].value}`,
          parts: [m[i], m[j]].map((r) => ({ path: r.path, locator: r.locator, field: r.field, value: Number(r.value) })),
        };
      }
    }
  }
  return null;
}

export async function checkProvenance(db, text, { client = null, minClaim = 1 } = {}) {
  const claims = claimsIn(text).filter((c) => Number(c.value) >= minClaim);
  const rows = await allRows(db);
  return claims.map((c) => {
    const cls = unitCls(c.unit);
    const same = rows.filter((r) => Number(r.value) === Number(c.value) && unitCls(r.unit) === cls && scopes(r, client));
    if (same.length) {
      const best = same.sort((a, b) => rankOf(a.derived_level) - rankOf(b.derived_level));
      return { ...c, status: 'supported', cites: best.slice(0, 3).map((m) => ({ path: m.path, locator: m.locator, field: m.field, quote: m.context })) };
    }
    const heads = headTokens(c);
    const auth = rows
      .filter((r) => Number(r.value) !== Number(c.value) && unitCls(r.unit) === cls && scopes(r, client)
        && heads.all.some((h) => norm((r.field ?? '') + ' ' + r.context).includes(h)))
      .sort((a, b) => headHits(b, heads) - headHits(a, heads));
    if (auth.length) {
      return {
        ...c, status: 'contradiction',
        contradictedBy: auth.slice(0, 3).map((m) => ({ path: m.path, locator: m.locator, field: m.field, value: Number(m.value), quote: m.context, level: m.derived_level })),
      };
    }
    const derived = cls === 'money' ? deriveFrom(rows, Number(c.value)) : null;
    return { ...c, status: derived ? 'derived' : 'unsupported', derivation: derived ?? null };
  });
}

export function provenanceDecision(checks) {
  const bad = checks.filter((c) => c.status === 'unsupported' || c.status === 'contradiction');
  const derived = checks.filter((c) => c.status === 'derived');
  if (bad.length) return { decision: 'BLOCK', bad, derived };
  if (derived.length) return { decision: 'HOLD_FOR_APPROVAL', bad, derived };
  return { decision: 'ALLOW', bad, derived };
}

export async function highestLevel(db, paths) {
  let hv = -1;
  for (const p of paths) {
    const r = await db.query('select derived_level from files where path=$1', [p]);
    hv = Math.max(hv, rankOf(r.rows[0]?.derived_level));
  }
  return hv < 0 ? null : Object.keys(LEVELS)[hv];
}

/** Non-numeric statements worth citing, e.g. "Status: UNPAID". */
export async function findLine(db, path, like) {
  const r = await db.query(`select path, locator, text as context from lines where path = $1 and text ilike '%'||$2||'%' limit 1`, [path, like]);
  return r.rows[0] ?? null;
}
