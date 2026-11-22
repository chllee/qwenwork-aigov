// src/briefing.mjs — the morning briefing, rendered deterministically from the ledger.
// No model writes this. Same rows, same verdicts, same citations as the API — which is
// the only way the text and the screen can't disagree in front of a judge.

const sev = { high: 3, medium: 2, low: 1 };
const E = (r, k) => (typeof r === 'string' ? JSON.parse(r || 'null') : r?.[k]);

export async function buildBriefing(db, runId, day = new Date().toISOString().slice(0, 10)) {
  const rows = (await db.query(`select * from events where run_id = $1 order by seq asc`, [runId])).rows;
  const intents = rows.filter((r) => r.kind === 'intent' && r.actor_kind === 'worker');
  const verdicts = rows.filter((r) => r.kind === 'verdict');
  const findings = rows.filter((r) => r.kind === 'finding');
  const human = rows.filter((r) => r.kind === 'intent' && r.actor_kind === 'human');
  const executed = rows.filter((r) => r.decision === 'EXECUTED');
  const blocked = verdicts.filter((v) => v.decision === 'BLOCK');
  const held = verdicts.filter((v) => v.decision === 'HOLD_FOR_APPROVAL');
  const allowed = verdicts.filter((v) => v.decision === 'ALLOW');

  const agentName = (s) => ({ S1: 'marketing agent', S2: 'sales agent', S3: 'ops agent', S4: 'finance agent', S5: 'support agent' })[s] ?? 'an agent';

  const lines = [];
  const push = (who, text) => lines.push({ who, text, severity: 0 });

  const nActions = verdicts.length;
  const pl = (n, w) => `${n} ${w}${Number(n) === 1 ? '' : 's'}`;
  const were = (n) => `${n} ${Number(n) === 1 ? 'was' : 'were'}`;
  const headline = held.length || blocked.length
    ? `You gave your agents ${pl(count(human), 'job')}. They attempted ${pl(nActions, 'action')}: ${were(blocked.length)} stopped, ${were(held.length)} waiting for you.`
    : `You gave your agents ${pl(count(human), 'job')}. They attempted ${pl(nActions, 'action')}. Nothing was stopped, and nothing is waiting on you.`;
  push('headline', headline);

  const moneyFindings = findings.filter((f) => /floor_breach|delete_unpaid_record|unsupported|contradicted|terms_change|data_egress/.test(String(E(f.payload, 'finding'))));
  for (const f of moneyFindings) {
    push(agentOf(f, rows), clean(String(f.reason)));
  }
  for (const v of held.filter((x) => !moneyFindings.some((f) => f.action === x.action))) {
    push(agentOf(v, rows), `${label(v.action)} is waiting for you. ${short(v.reason)}.`);
  }
  const creep = findings.filter((f) => String(E(f.payload, 'finding')) === 'scope_creep' || String(E(f.payload, 'finding')) === 'data_access_violation');
  if (creep.length) {
    const files = [...new Set(creep.map((f) => fileIn(String(f.reason))))].filter(Boolean);
      push('oversight', `while doing other jobs, an agent opened ${list(files)} — none of it needed for the task you gave it. Nothing was sent, but you should know it looked.`);
  }
  const fups = verdicts.flatMap((v) => E(v.payload, 'followups') ?? []);
  for (const f of fups) push('oversight', `Due today: ${clean(f.text)}${f.due_hours ? ` (within ${f.due_hours} hours)` : ''}.`);

  const approved = rows.filter((r) => r.kind === 'approval');
  for (const a of approved) push('mei.tan', `You ${E(a.payload, 'verdict') === 'deny' ? 'declined' : 'released'} ${fileIn(String(a.reason)) ?? label(E(a.payload, 'action'))}.`);

    push('summary', `Outcomes — carried out: ${executed.length}. Stopped before they happened: ${blocked.length}. Waiting for you: ${held.length}. Files opened that the job did not need: ${creep.length}.`);

  return {
    runId, day, headline: lines[0].text, lines,
    counts: { tasks: count(intents), actions: verdicts.length, allowed: allowed.length, held: held.length, blocked: blocked.length, executed: executed.length, findings: findings.length, scope_events: creep.length },
    script: toScript(lines),
  };
}
const count = (a) => a.length;
function agentOf(ev, rows) {
  const intent = rows.find((r) => r.seq === Number(E(ev.payload, 'intent_seq')));
  return intent ? clean(shortAgent(String(intent.actor))) : 'an agent';
}
const shortAgent = (a) => a.replace('worker.', '') + ' agent';
function label(a) {
  return { send_email: 'an email', upload_to_external_tool: 'an upload', delete_file: 'a request to delete a file', order_from_supplier: 'an order', quote_price: 'a price', read_file: 'a file read' }[a] ?? String(a).replace(/_/g, ' ');
}
const short = (s) => String(s ?? '').split('|')[0].trim();
const pretty = (p) => String(p).split('/').pop().replace(/^\d{4}-\d\d-\d\d[-_]?/, '').replace(/_20\d\d$/, '').replace(/\.(md|csv|txt|pdf|json)$/i, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const fileIn = (s) => { const m = (String(s).match(/[\w./-]+\.(md|csv|txt|pdf)/) ?? [])[0]; return m ? pretty(m) : null; };
const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
const list = (a) => (a.length < 2 ? a[0] ?? '' : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

/** ~150 words ≈ 60 seconds at a calm reading pace. */
export function toScript(lines) {
  const parts = [];
  for (const l of lines) {
    if (l.who === 'headline') parts.push(`Good morning. ${l.text}`);
    else if (l.who === 'oversight' && /^(while|due)/i.test(l.text)) parts.push(`One more thing — ${l.text}`);
    else if (l.who === 'summary') parts.push(l.text);
    else if (l.who === 'oversight') parts.push(`Note. ${l.text}`);
    else if (l.who === 'mei.tan') parts.push(l.text);
    else parts.push(`Your ${l.who} ${l.text}`);
  }
  const s = parts.join(' ');
  const words = s.split(/\s+/);
  return { text: words.length > 165 ? words.slice(0, 165).join(' ') + ' …' : s, words: Math.min(words.length, 165), seconds: Math.round(Math.min(words.length, 165) / 2.5) };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
