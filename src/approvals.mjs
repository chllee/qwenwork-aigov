// src/approvals.mjs — the owner's side of the gate.
//
// An approval is scoped to one payload hash and expires. One "yes" to a draft
// cannot become a standing licence, which is the quiet way oversight layers fail.
// No answer by the deadline is a deny, and the deny is written down.

import { append, ledger } from './log.mjs';
import { sha256, canonical } from './log.mjs';

export const payloadHash = (args) => sha256(canonical(args ?? {})).slice(0, 16);

/** Owner releases or denies a held action. */
export async function decide(db, { runId, seq, verdict, actor = 'mei.tan', note = null, args = null }) {
  const rows = await ledger(db, { runId });
  const held = rows.find((r) => r.seq === Number(seq));
    if (!held) return { ok: false, error: `no ledger row ${seq}` };
  if (held.decision !== 'HOLD_FOR_APPROVAL') return { ok: false, error: `row ${seq} is ${held.decision}, not waiting on you` };
  const already = rows.find((r) => r.kind === 'approval' && Number(r.approval_for) === held.seq);
  if (already) return { ok: false, error: `already ${already.payload?.verdict ?? 'answered'} at ${already.ts} — an approval is single use` };
  const ph = payloadHash(args ?? held.action ?? null);
  const ev = await append(db, {
    run_id: runId, actor, actor_kind: 'human', kind: 'approval', action: held.action,
    approval_for: held.seq, decision: verdict === 'allow' ? 'RELEASED' : 'DENIED',
    reason: note ?? (verdict === 'allow' ? 'owner released this action' : 'owner denied this action'),
    payload: { verdict, payload_hash: ph, intent_seq: Number(held.payload?.intent_seq ?? held.seq), scoped_to: 'this payload only', expires: 'single use' },
  });
  if (verdict === 'allow') {
    await append(db, {
      run_id: runId, actor: 'gateway', actor_kind: 'system', kind: 'result', action: held.action,
      decision: 'EXECUTED', reason: 'performed by the gateway after an owner release',
      payload: { released_by: actor, approval_seq: ev.seq, payload_hash: ph, held_seq: held.seq },
    });
  }
  return { ok: true, event: ev };
}

/** Deadline passed with no answer: deny, and say so in the ledger. */
export async function sweepTimeouts(db, runId, { maxAgeMinutes = 0, now = Date.now() } = {}) {
  const rows = await ledger(db, { runId });
  const answered = new Set(rows.filter((r) => r.kind === 'approval').map((r) => Number(r.approval_for)));
  const timedOut = [];
  for (const r of rows) {
    if (r.decision !== 'HOLD_FOR_APPROVAL' || answered.has(r.seq)) continue;
    if (now - Date.parse(r.ts) < maxAgeMinutes * 60_000) continue;
    await append(db, {
      run_id: runId, actor: 'gateway', actor_kind: 'system', kind: 'approval', action: r.action,
      approval_for: r.seq, decision: 'DENIED', reason: 'no answer by the deadline, so the default is no',
      payload: { verdict: 'timeout_deny', policy: 'default-deny on expiry' },
    });
    timedOut.push(r.seq);
  }
  return timedOut;
}
