// src/dispatch.mjs — the single place any action becomes real.
//
// This is the seam Kagi will be inserted into. Today the decision is
// 'passthrough' (do the thing), because an invented ALLOW would be theatre just as
// surely as an invented BLOCK would. What already exists, and cannot be bolted on
// later: the actor is resolved here from a token the caller never gets to write in
// its own payload; nothing executes without an 'intent' line first; nothing happens
// silently either way.
import { VERBS } from './world.mjs';
import { emit } from './journal.mjs';

const MODE = process.env.KAGI_MODE === 'gated' ? 'gated' : 'passthrough';

// Identity is minted here. A caller naming itself 'mei.tan' in its own JSON body
// is not who the ledger records.
const PRINCIPALS = new Map();
export function mint(who, label) {
  const token = Math.random().toString(36).slice(2, 12);
  PRINCIPALS.set(token, { who, label });
  return token;
}
export function who(token) { return PRINCIPALS.get(token) || null; }

export async function act(token, { verb, args = {}, session = 's0' }) {
  const me = who(token);
  if (!me) return { error: 'unauthorised: no principal for that token', code: 'E_AUTH' };
  if (!VERBS[verb]) {
    await emit({ session, actor: me.who, event: 'refused', verb, args, mode: MODE, outcome: { error: 'unknown verb' } });
    return { error: `no such verb: ${verb}`, allowed: Object.keys(VERBS) };
  }

  // Record the request before the world can change. If this line is missing there
  // is no action, which is the only ordering that makes a later veto believable.
  const intent = await emit({ session, actor: me.who, event: 'intent', verb, args, mode: MODE });

  /* ═══ KAGI GATE ═══════════════════════════════════════════════════════════
     A decision object lands here: { decision, rules, evidence, explanation }.
       passthrough  -> perform, and record what was performed
       HOLD_FOR_APPROVAL -> perform nothing; queue the intent
       BLOCK        -> perform nothing; the world must stay provably untouched
     Nothing below this comment may run until the verdict says so.
     ═════════════════════════════════════════════════════════════════════════ */
  const decision = { decision: MODE === 'gated' ? 'PASSTHROUGH' : 'PASSTHROUGH', rules: [], evidence: [], explanation: 'no gate attached yet' };

  const outcome = await VERBS[verb]({ ...args, actor: me.who });
  await emit({ session, actor: 'gateway', event: 'effect', verb, args: { of: intent.seq }, mode: MODE,
    outcome: { decision: decision.decision, result: shape(verb, outcome) } });
  return { ...outcome, decision: decision.decision, journal: { intent: intent.seq } };
}

// Keep the journal small and readable: never log file contents, only their identity.
function shape(verb, r) {
  switch (verb) {
    case 'read_file': return { path: r.path, bytes: r.bytes, sha256_of_text: r.text ? r.text.length + ' chars' : null };
    case 'list_dir': return { entries: Array.isArray(r.listing) ? r.listing.length : 0 };
    case 'delete_file': return { deleted: r.deleted, trash: r.trash, bytes: r.bytes };
    case 'send_email': return { to: r.to, delivered: r.delivered, sent: r.sent || null, draft: r.draft };
    case 'upload_to_external_tool': return { tool: r.tool, egress: r.egress, bytes: r.bytes };
    default: return { ok: r.ok };
  }
}
