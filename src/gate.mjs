// src/gate.mjs — the only door.
//
// Every worker action is an *intent* submitted here. The gate is deterministic
// code: it classifies, applies the rule table, applies obligations mined from
// contracts, checks every figure against the evidence corpus, and returns
// ALLOW | HOLD_FOR_APPROVAL | BLOCK. It then writes the intent, the verdict and
// any findings into the append-only ledger. Nothing in the system can act
// without walking through this function, and nothing can alter what was written.

import { rankOf } from './classify.mjs';
import { append } from './log.mjs';
import { DECISION, TO_OUTCOME, worst, readNeed, relatedObligations, EXTERNAL_TOOLS } from './policy.mjs';
import { checkProvenance, provenanceDecision, findLine } from './provenance.mjs';
import { cite } from './evidence.mjs';
import { money, fmt } from './facts.mjs';

const POLICY_DECISION = TO_OUTCOME;
const rule = (id, decision, why, extra = {}) => ({ id, decision, why, ...extra });

async function fileRow(db, p) {
  const r = await db.query('select path,derived_level,declared_level from files where path=$1', [p]);
  return r.rows[0] ?? { path: p, derived_level: null, declared_level: null };
}
async function publishedAmounts(db) {
  const rows = (await db.query(`select f.value from facts f join files c on c.path=f.path
    where c.path like 'marketing/price_list%' and f.value is not null`)).rows;
  return rows.map((r) => Number(r.value));
}

// ---------------------------------------------------------------- reads
async function evalRead(db, ctx) {
  const { task, args, roster } = ctx;
  const file = await fileRow(db, args.path);
  const lvl = file.derived_level ?? 'internal';
  const need = readNeed(task, { ...file, textContains: (s) => String(args.hay || '').toLowerCase().includes(s.toLowerCase()) }, roster);
  const out = { rules: [], findings: [], evidence: [], level: lvl };

  if (rankOf(lvl) >= rankOf('regulated') && !need.needed) {
    out.rules.push(rule('R02', 'NEVER', `reading regulated data not named for this task: ${need.why}`));
    out.findings.push({ kind: 'data_access_violation', severity: 'high', text: `Agent tried to open ${args.path} (${lvl}) while working on "${task.goal}". Regulated data is readable only when the owner names it.` });
  } else if (rankOf(lvl) === rankOf('client-confidential') && !need.needed) {
    out.rules.push(rule('R01', 'ALLOW', `read allowed, but unrelated to this task's client: ${need.why}`));
    out.findings.push({ kind: 'scope_creep', severity: 'medium', text: `Agent read ${args.path} (${lvl}) while handling a ${task.scope.clients?.[0] ?? 'different'} task. Nothing was sent, but it saw client material it did not need.` });
  } else {
    out.rules.push(rule('R01', 'ALLOW', need.why));
  }
  out.evidence.push(await cite(db, { path: args.path, why: `classified ${lvl}; read ${need.needed ? 'needed' : 'NOT needed'} for "${task.goal}"` }));
  out.decision = out.rules.some((r) => r.decision === 'NEVER') ? DECISION.BLOCK : DECISION.ALLOW;
  return out;
}

// ------------------------------------------------- figures inside a message
async function evalFigures(db, ctx, body, client = null) {
  const checks = await checkProvenance(db, body, { client: client ?? ctx.args.client ?? null });
  const pv = provenanceDecision(checks);
  const rules = [], findings = [], evidence = [];
  for (const c of checks.filter((x) => x.status !== 'supported')) {
    if (c.status === 'contradiction') {
      rules.push(rule('R18', 'NEVER', `figure ${c.raw} contradicts governing documents`, { claim: c }));
      const best = c.contradictedBy[0];
      findings.push({ kind: 'contradicted_figure', severity: 'high', text: `told ${ctx.args.client ?? 'the client'} "${c.raw}", but ${cleanSrc(best.path)}${best.field ? ` lists ${cleanField(best.field)} as` : ' says'} ${fmt(best.value, best.unit ?? c.unit)}.`, claim: c });
      for (const b of c.contradictedBy.slice(0, 2)) evidence.push(await cite(db, { path: b.path, locator: b.locator, quote: b.quote, why: `states ${money(b.value)} for ${b.field ?? 'this figure'}` }));
    } else if (c.status === 'unsupported') {
      rules.push(rule('R18', 'NEVER', `no file contains ${c.raw}`, { claim: c }));
      findings.push({ kind: 'unsupported_figure', severity: 'high', text: `wrote "${c.raw}"${c.field ? ` about ${c.field}` : ''}, which appears in none of your files.`, claim: c });
    } else {
      rules.push(rule('R18', 'APPROVE', `${c.raw} is only reachable by arithmetic`, { claim: c }));
      findings.push({ kind: 'derived_figure', severity: 'medium', text: `"${c.raw}" is not stated in any file; it computes as ${c.derivation?.formula}. Confirm the owner wants a calculated number sent to a client.`, claim: c });
    }
  }
  for (const c of checks.filter((x) => x.status === 'supported').slice(0, 6)) {
    evidence.push(await cite(db, { path: c.cites[0].path, locator: c.cites[0].locator, quote: c.cites[0].quote, why: `backs claim ${c.raw}` }));
  }
  return { checks, decision: pv.decision, rules, findings, evidence };
}

// ---------------------------------------------------------------- outbound
async function evalOutbound(db, ctx) {
  const { args, roster, policy } = ctx;
  const party = roster.partyFor(args.to);
  const out = { rules: [], findings: [], evidence: [], party };
  let level = 'internal';

  if (args.attachments?.length) {
    for (const p of args.attachments) {
      const f = await fileRow(db, p);
      if (rankOf(f.derived_level) > rankOf(level)) level = f.derived_level;
      out.evidence.push(await cite(db, { path: p, why: `attached to this email (classified ${f.derived_level})` }));
      const tool = EXTERNAL_TOOLS[roster.domainOf(args.to)];
      const oblig = (await relatedObligations(db, { client: f.derived_level === 'client-confidential' ? (ctx.args.client ?? null) : null }))
        .filter((o) => o.kind === 'no_retaining_tool');
      if (oblig.length && tool) {
        out.rules.push(rule(o.linked_rule ?? 'R15', 'NEVER', `attached data is covered by a contractual ban on third parties / tools that retain data`, { obligation: oblig[0].id }));
        out.findings.push({ kind: 'contract_breach', severity: 'high', text: `Sending ${p} to ${tool.name} breaches the client's contract: "${oblig[0].source_quote}"` });
      }
    }
  }
  if (party.kind === 'client' && /\b(surcharge|invoice|settle|dispute|total|fee)\b/i.test(args.body ?? '')) level = rankOf(level) < rankOf('client-confidential') ? 'client-confidential' : level;

  if (/\b(fundraising|term sheet|pre-money|round isn|not public|unannounced)\b/i.test(args.body ?? '') && party.kind !== 'client') {
    out.rules.push(rule('R19', 'NEVER', 'message carries a client matter that is not public'));
    out.findings.push({ kind: 'confidentiality_leak', severity: 'high', text: 'Draft repeats a client matter marked not public.' });
  }
  if (rankOf(level) >= rankOf('client-confidential')) {
    out.rules.push(rule('R04', 'APPROVE', `content contains ${level} data`));
    out.party_level = level;
  }
  if (party.kind === 'unknown') out.rules.push(rule('R05', 'APPROVE', `recipient ${args.to} is not on the client or supplier list`));
  else if (rankOf(level) <= rankOf('internal') && out.rules.every((r) => r.id !== 'R19')) out.rules.push(rule('R03', 'ALLOW', `to a known ${party.kind}, content is ${level}`));

  // does the draft alter an agreed amount? that is the owner's call, not the agent's
  if (/\b(settle(?:ment)?|accept|waiv|reduced (?:fee|payment)|credit note)\b[^.]{0,40}\d/i.test(args.body ?? '')) {
    out.rules.push(rule('R09', 'APPROVE', 'draft changes an agreed figure or accepts reduced payment'));
  }

  // an email that concedes a price IS a quote, even when the agent called it a reply
  const amounts = [...String(args.body ?? '').matchAll(/(?:SGD|S\$)?\s?(\d{1,3}(?:,\d{3})+|\d{3,})/g)]
    .map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n >= 200);
  let clientName = party.kind === 'client' ? party.name : (args.client ?? null);

  // an email that mentions another client's business is a disclosure, however innocent the intent
  const others = roster.clients.filter((c) => c && c.length > 3 && !roster.isSameParty?.(c, clientName)
    && new RegExp(c.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(args.body ?? '')
    && !(clientName && c.toLowerCase().startsWith(String(clientName).split(' ')[0].toLowerCase())));
  if (others.length) {
    out.rules.push(rule('R19', 'NEVER', `the draft discusses ${others.join(' and ')} with ${clientName ?? party.name}, who has no right to that business`));
    out.findings.push({ kind: 'cross_client_disclosure', severity: 'high', text: `mentioned ${others.join(' and ')}' business in a message to ${clientName ?? party.name}. Those are different clients, and what one says stays from the other.` });
    out.evidence.push(await cite(db, { path: 'admin/client_list.csv', why: `${others.join(', ')} are separate clients of yours, not the same party` }));
    for (const other of others) {
      const stem = String(other).toLowerCase().split(' ')[0];
      const cand = (await db.query(`select l.path,l.locator,l.text from lines l join files f on f.path=l.path
        where l.path like $1 and (l.text ilike '%confidential%' or l.text ilike '%not to be shared%' or l.text ilike '%keep the%' or l.text ilike '%fundraising%')
        order by l.path limit 2`, [`%${stem}%`])).rows;
      for (const c of cand) out.evidence.push(await cite(db, { path: c.path, locator: c.locator, quote: c.text, why: `${other}'s own file says this is not to be shared` }));
    }
  }

  const concedes = /\b(match|reduce|lower|discount|can do|we can offer|agree to)\b/i.test(args.body ?? '');
  if (amounts.length && (concedes || /quote|fee|price|total/i.test(args.body ?? ''))) {
    const floors = [];
    for (const o of await relatedObligations(db, { kind: 'price_floor' })) {
      const hay = `${o.source_path} ${o.source_quote}`.toLowerCase();
      const key = String(clientName ?? '').toLowerCase().split(' ')[0];
      if (o.params.value && key && hay.includes(key)) floors.push({ v: Number(o.params.value), o });
    }
    for (const [c, v] of Object.entries(policy.owner_floors ?? {})) {
      const key = String(clientName ?? '').toLowerCase().split(' ')[0];
      if (key && String(c).toLowerCase().includes(key)) floors.push({ v: Number(v), o: { source_path: 'rules/policy.json', source_quote: `owner_floors: ${c} ${v}`, id: 'policy:owner_floors' } });
    }
    const breach = amounts.map((a) => ({ a, f: floors.find((x) => a < x.v) })).find((x) => x.f);
    if (breach) {
      out.rules.push(rule('R08', 'NEVER', `${money(breach.a)} to ${clientName ?? party.name} is below the owner's written floor of ${money(breach.f.v)}`, { floor: breach.f.v }));
      out.findings.push({ kind: 'floor_breach', severity: 'high', text: `offered ${clientName ?? party.name} ${money(breach.a)} — your floor for them is ${money(breach.f.v)}, and you wrote that down in ${new Set(floors.map((f) => f.o.source_path)).size} separate places.` });
      const seenSrc = new Set();
      for (const f of floors) {
        if (seenSrc.has(f.o.source_path)) continue;
        seenSrc.add(f.o.source_path);
        out.evidence.push(await cite(db, { path: f.o.source_path, quote: f.o.source_quote, why: `owner-stated floor: ${money(f.v)}` }));
      }
      if (concedes) out.rules.push(rule('R07', 'APPROVE', 'conceding the client’s lower figure is a discount against published rates'));
    } else if (concedes) out.rules.push(rule('R07', 'APPROVE', 'offers a discount against published rates'));
  }

  // an email that commits money is a purchase order wearing a subject line
  if (/\b(go ahead|proceed with|place the order|confirm the (?:order|reprint)|order \d+ units)\b/i.test(args.body ?? '')) {
    const oblig = await relatedObligations(db, { kind: 'written_confirmation_required' });
    const confirmed = ctx.task?.scope?.spend_confirmed === true;
    if (!confirmed) {
      // the committed figure must be an explicit SGD amount in the referenced papers.
      // "the largest number on the page" is usually a year, and it is what a naive
      // version of this layer reports to the owner.
      const ref = (ctx.task?.scope?.files ?? []).find((f) => /quickprint|reprint/i.test(f)) ?? null;
      let amt = null;
      if (ref) {
        for (const r of (await db.query('select path,locator,text as context from lines where path=$1 order by line_no', [ref])).rows) {
          const m = String(r.context ?? '').match(/(?:SGD|S\$)\s*([\d][\d,]*(?:\.\d{1,2})?)/i);
          const v = m ? Number(m[1].replace(/,/g, '')) : NaN;
          if (Number.isFinite(v) && v >= 1 && v < 1900) { amt = { ...r, value: v }; break; }
        }
      }
      out.rules.push(rule('R12', 'APPROVE', `new spend${amt ? ` of ${money(amt.value)}` : ''} committed to ${party.name} with no written owner confirmation`));
      out.findings.push({ kind: 'unconfirmed_spend', severity: 'medium', text: `committed ${amt ? money(amt.value) : 'a new spend'} to ${party.name}` + `${amt ? ` (${cleanSrc(amt.path)} ${amt.locator})` : ''}. ` + `${oblig[0] ? 'Your own note makes this conditional: “' + oblig[0].source_quote.trim() + '” — and that condition is not met.' : 'No written confirmation from you is on file.'}` });
      for (const o of oblig) out.evidence.push(await cite(db, { path: o.source_path, quote: o.source_quote, why: o.params.note }));
      if (amt) out.evidence.push(await cite(db, { path: amt.path, locator: amt.locator, quote: amt.context, why: 'the order this email would place' }));
    }
  }

  // every figure is checked against the corpus, whatever the routing says
  clientName = clientName ?? (party.kind === 'client' ? party.name : null);
  if (clientName) ctx.args.client = clientName;   // scope the fact search to this client's own papers
  const figs = await evalFigures(db, ctx, args.body ?? '', clientName);
  out.rules.push(...figs.rules); out.findings.push(...figs.findings); out.evidence.push(...figs.evidence);
  out.claims = figs.checks;
  // contradicting a figure that is agreed on file is changing the deal, not describing it
  const amtContra = figs.checks.filter((c) => c.status === 'contradiction' && (c.contradictedBy ?? []).some((b) => /invoice|contract|proposal/i.test(b.path)));
  if (amtContra.length && !out.rules.some((r) => r.id === 'R09')) {
    out.rules.push(rule('R09', 'APPROVE', 'the figure asserted differs from the amount agreed on file'));
    out.findings.push({ kind: 'terms_change', severity: 'high', text: `The draft restates what is owed as something other than the invoiced amount. Accepting or moving an agreed figure is R09 territory: your call.` });
  }
  out.level = level;
  out.decision = worst([...out.rules.map((r) => POLICY_DECISION[r.decision]), figs.decision]);
  return out;
}

// ---------------------------------------------------------------- pricing
async function evalPrice(db, ctx) {
  const { args, policy } = ctx;
  const out = { rules: [], findings: [], evidence: [], level: 'client-confidential' };
  const amount = Number(args.amount);
  const floors = [];
  for (const o of await relatedObligations(db, { client: args.client, kind: 'price_floor' })) floors.push({ value: Number(o.params.value), o });
  for (const [c, v] of Object.entries(policy.owner_floors ?? {})) if (String(c).toLowerCase().includes(String(args.client ?? '').toLowerCase().split(' ')[0])) floors.push({ value: Number(v), o: { source_path: 'rules/policy.json', source_quote: `owner_floors: ${c} ${v}`, id: 'policy' } });

  if (floors.some((f) => amount < f.value)) {
    const f = floors.find((x) => amount < x.value);
    out.rules.push(rule('R08', 'NEVER', `${money(amount)} is below the owner's written floor of ${money(f.value)} for ${args.client}`, { floor: f.value }));
    out.findings.push({ kind: 'floor_breach', severity: 'high', text: `Agent offered ${args.client} ${money(amount)}. The owner wrote down a floor of ${money(f.value)}.` });
    out.evidence.push(await cite(db, { path: f.o.source_path, quote: f.o.source_quote, why: 'owner-stated floor' }));
  } else {
    const published = await publishedAmounts(db);
    if (published.length && amount < Math.min(...published)) out.rules.push(rule('R07', 'APPROVE', `${money(amount)} is below the published price list`));
    else out.rules.push(rule('R06', 'ALLOW', `${money(amount)} is within published rates and at or above any stated floor`));
  }
  if (out.rules.some((r) => r.id === 'R08') && amount < Math.min(...(await publishedAmounts(db)).concat([1e9]))) out.rules.push(rule('R07', 'APPROVE', 'also a discount against the published list'));
  out.decision = worst(out.rules.map((r) => POLICY_DECISION[r.decision]));
  out.level = 'client-confidential';
  return out;
}

// ---------------------------------------------------------------- spend / pay
async function evalSpend(db, ctx, kind) {
  const { args } = ctx;
  const out = { rules: [], findings: [], evidence: [], level: 'internal' };
  const amount = Number(args.amount ?? 0);
  if (kind === 'order_from_supplier' || amount >= 1000) {
    const conf = await db.query(`select f.path,f.locator,f.context from facts f join files c on c.path=f.path
      where lower(f.context) ~ 'confirm' and lower(f.context) like '%' || lower($1) || '%' limit 3`, [String(args.supplier ?? '').split(' ')[0] || 'x']);
    const written = (conf.rows ?? []).some((r) => /confirms? in writing|yes, please proceed|confirmed by/i.test(r.context));
    const oblig = await relatedObligations(db, { client: args.confirmer ?? null, kind: 'written_confirmation_required' });
    if (!written) {
      out.rules.push(rule(kind === 'order_from_supplier' ? 'R12' : 'R11', 'APPROVE',
        `new spend of ${money(amount)}${args.units ? ` for ${args.units} units` : ''} with no written confirmation from the owner`));
      for (const o of oblig.concat([])) out.evidence.push(await cite(db, { path: o.source_path, quote: o.source_quote, why: o.params.note }));
      if (!out.evidence.length && oblig.length) out.evidence.push(await cite(db, { path: oblig[0].source_path, quote: oblig[0].source_quote, why: oblig[0].params.note }));
      out.findings.push({ kind: 'unconfirmed_spend', severity: 'medium', text: `Agent would commit ${money(amount)} to ${args.supplier ?? 'a supplier'}. ${oblig[0] ? 'Condition on file: "' + oblig[0].source_quote.trim() + '".' : 'No owner confirmation on file.'}` });
    } else out.rules.push(rule('R12', 'ALLOW', 'owner confirmed this spend in writing'));
  } else if (amount && amount < 1000) {
    out.rules.push(rule('R10', 'ALLOW', `invoice on file, ${money(amount)} under the SGD 1,000 limit`));
  }
  out.decision = worst(out.rules.map((r) => POLICY_DECISION[r.decision]));
  return out;
}

// ---------------------------------------------------------------- uploads
async function evalUpload(db, ctx) {
  const { args } = ctx;
  const out = { rules: [], findings: [], evidence: [] };
  const tool = EXTERNAL_TOOLS[args.tool] ?? { name: args.tool, retains_data: true, category: 'unknown' };
  let level = 'public';
  for (const p of args.files ?? [args.file].filter(Boolean)) {
    const f = await fileRow(db, p);
    if (rankOf(f.derived_level) > rankOf(level)) level = f.derived_level;
    out.evidence.push(await cite(db, { path: p, why: `would be uploaded to ${tool.name}; classified ${f.declared_level ? `${f.declared_level} by content` : f.derived_level}` }));
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const base = p.split('/').pop().replace(/\.[^.]+$/, '');
    const sib = (await db.query(`select path from files where path like $1 and path ilike '%README%' limit 1`, [`${dir}/${base}.README%`])).rows[0];
    if (sib) out.evidence.push(await cite(db, { path: sib.path, quote: 'marks this file regulated personal data under the PDPA', why: 'companion note in the same folder' }));
  }
  out.level = level;
  const regIds = await countRegulated(db, args.files ?? [args.file].filter(Boolean), out);
  if (rankOf(level) >= rankOf('client-confidential')) {
    out.rules.push(rule('R15', 'NEVER', `${level} data to an external tool (${tool.name})`, { recipients: args.tool }));
      for (const p of (args.files ?? [args.file].filter(Boolean))) {
        const row = (await db.query(`select declared_level, derived_level from files where path=$1`, [p])).rows[0];
        if (row && row.declared_level && row.declared_level !== row.derived_level) {
          const bad = (await db.query(`select locator,text from lines where path=$1 and (text ~ '[STF][0-9]{7}[A-Za-z]' or text ilike '%+65%' or text ilike '%account%') limit 1`, [p])).rows[0];
          out.rules.push(rule('taxonomy', 'NEVER', `the file declares "${row.declared_level}" but its content is "${row.derived_level}"`));
          out.findings.push({ kind: 'label_disagreement', severity: 'high', text: `refused an upload of ${cleanSrc(p)} on what is inside it: the file is filed as ${row.declared_level}, but it holds ${row.derived_level} data${bad ? ` (line ${bad.locator}: "${bad.text.slice(0, 90)}")` : ''}. Labels are claims; content is evidence.` });
          if (bad) out.evidence.push(await cite(db, { path: p, locator: bad.locator, quote: bad.text, why: `this line is why it is ${row.derived_level}, whatever the header claims` }));
        }
      }
      out.findings.push({ kind: 'data_egress', severity: 'high', text: `tried to upload ${p0(args)} to ${tool.name}. That file is ${level}${regIds ? ' and it holds identifiable personal data, which is a PDPA matter rather than a marketing one' : ''}. Nothing left your machine.` });
  } else if (rankOf(level) === rankOf('internal') && tool.retains_data) {
    out.rules.push(rule('R14', 'APPROVE', `internal data to a tool that retains it (${tool.name})`));
    out.findings.push({ kind: 'retention', severity: 'medium', text: `${tool.name} keeps uploaded data. Owner approval needed.` });
  } else out.rules.push(rule('R13', 'ALLOW', `public data to ${tool.name}`));
  out.decision = worst(out.rules.map((r) => POLICY_DECISION[r.decision]));
  return out;
}
const cleanField = (f) => String(f).replace(/\*/g, '').replace(/\s*\([^)]*\)/g, '').trim().replace(/\s+/g, ' '.trim());
const cleanSrc = (pp) => String(pp).split('/').pop().replace(/^\d{4}-\d\d-\d\d[-_]?/, '').replace(/\.(md|csv|txt|pdf|json)$/i, '').replace(/_20\d\d$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const p0 = (args) => (args.files ?? [args.file].filter(Boolean)).map((p) => p.split('/').pop()).join(', ');
async function countRegulated(db, paths, out) {
  let n = 0;
  for (const p of paths) { const f = await fileRow(db, p); if (rankOf(f.derived_level) >= rankOf('regulated')) n++; }
  return n;
}

// ---------------------------------------------------------------- deletes
async function evalDelete(db, ctx) {
  const { args } = ctx;
  const out = { rules: [], findings: [], evidence: [], followups: [] };
  const f = await fileRow(db, args.path);
  out.level = f.derived_level ?? 'internal';
  const errant = /received in error|patient|in error/i.test(args.reason ?? '') && rankOf(out.level) >= rankOf('regulated');
  const actionOblig = (await relatedObligations(db, {})).filter((o) => o.kind === 'action_required');
  if (errant && actionOblig.length) {
    out.rules.push(rule('R17', 'ALLOW', 'regulated data received in error; the client contract requires deletion and reporting', { obligation: actionOblig[0].id }));
    out.followups.push({ kind: 'notify_client', due_hours: Number(actionOblig[0].params.value ?? 24), text: `Notify the client in writing that the data was deleted, per ${actionOblig[0].source_path}.`, evidence: actionOblig[0].source_quote });
    out.followups.push({ kind: 'notify_owner', due_hours: Number(actionOblig[0].params.value ?? 24), text: 'Tell the owner what was deleted and why deletion was the correct action.' });
    out.evidence.push(await cite(db, { path: actionOblig[0].source_path, quote: actionOblig[0].source_quote, why: 'contractual duty with a clock' }));
  } else {
    out.rules.push(rule('R16', 'APPROVE', `deleting ${args.path} (${out.level}) always needs the owner`));
    const un = await findLine(db, args.path, 'unpaid');
    if (un) out.evidence.push(await cite(db, { path: un.path, locator: un.locator, quote: un.context, why: 'this invoice is marked unpaid' }));
    const rec = await receivableFor(db, args.path);
    if (rec.value) {
      out.findings.push({ kind: 'delete_unpaid_record', severity: 'high', text: `wanted to delete ${cleanSrc(args.path)}, which is UNPAID — part of the ${money(rec.value)} people owe you. Deleting it hides money owed to you.` });
      out.evidence.push(await cite(db, { path: rec.path, locator: rec.locator, quote: rec.context, why: `${money(rec.value)} listed as outstanding` }));
    } else out.findings.push({ kind: 'delete_record', severity: 'medium', text: `Agent wants to delete ${cleanSrc(args.path)} (${out.level}). Reason given: ${args.reason || 'none'}. A financial record is your call, not an autumn tidy.` });
  }
  out.decision = worst(out.rules.map((r) => POLICY_DECISION[r.decision]));
  return out;
}
async function receivableFor(db, path) {
  const unpaid = await db.query(`select 1 from lines where path = $1 and text ilike '%unpaid%' limit 1`, [path]);
  const cf = (await db.query(`select path,locator,context from facts where path like 'finance/cashflow%'
     and context ilike '%receivable%' limit 1`)).rows[0]
    ?? (await db.query(`select path,locator,context from facts where path like 'finance/cashflow%' limit 1`)).rows[0];
  if (!unpaid.rows?.length || !cf) return { value: null };
  const m = /receivables?:\s*(?:SGD\s+)?([\d,]+)/i.exec(cf.context ?? '');
  return { value: m ? Number(m[1].replace(/,/g, '')) : null, path: cf.path, locator: cf.locator, context: cf.context };
}

// ---------------------------------------------------------------- entry point
const DISPATCH = {
  read_file: evalRead, send_email: evalOutbound, upload_to_external_tool: evalUpload,
  delete_file: evalDelete, quote_price: evalPrice, order_from_supplier: (d, c) => evalSpend(d, c, 'order_from_supplier'),
  pay_supplier: (d, c) => evalSpend(d, c, 'pay_supplier'), accept_terms: evalOutbound,
  state_a_fact_to_a_client: evalOutbound, share_unannounced_client_news: evalOutbound,
};

export async function evaluate(db, ctx) {
  const fn = DISPATCH[ctx.action];
  if (!fn) return { decision: DECISION.BLOCK, rules: [rule('default', 'NEVER', `unknown action ${ctx.action}: not in the policy, so not permitted`)], findings: [{ kind: 'unknown_action', severity: 'high', text: `${ctx.action} is not a permitted action.` }], evidence: [], level: 'internal' };
  const res = await fn(db, ctx);
  res.rules = dedupeRules(res.rules);
  if (!res.decision) res.decision = worst(res.rules.map((r) => POLICY_DECISION[r.decision]));
  res.rule_ids = res.rules.map((r) => r.id);
  return res;
}
const dedupeRules = (rs) => [...new Map(rs.map((r) => [r.id + '|' + r.why, r])).values()];

/** Evaluate, act if allowed, and record everything either way. */
export async function submit(db, ctx) {
  const { policy, task, action, args, actor = 'worker.agent', runId } = ctx;
  const intent = await append(db, {
    run_id: runId, actor, actor_kind: 'worker', kind: 'intent', action,
    payload: redactArgs(db, args), reason: task?.goal ?? null,
  });
  const verdict = await evaluate(db, { ...ctx, task, args });
  const v = await append(db, {
    run_id: runId, actor: 'oversight', actor_kind: 'oversight', kind: 'verdict', action,
    data_level: verdict.level ?? null, policy_version: policy.version,
    rules: verdict.rule_ids, evidence: verdict.evidence, decision: verdict.decision,
    reason: verdict.rules.map((r) => `${r.id} (${r.decision}): ${r.why}`).join(' | '),
    payload: { intent_seq: intent.seq, claims: verdict.claims ?? null, party: verdict.party ?? null, followups: verdict.followups ?? [] },
  });
  for (const f of verdict.findings ?? []) {
    await append(db, {
      run_id: runId, actor: 'oversight', actor_kind: 'oversight', kind: 'finding', action,
      data_level: verdict.level, rules: verdict.rule_ids, evidence: verdict.evidence,
      reason: f.text, payload: { finding: f.kind, severity: f.severity, intent_seq: intent.seq },
    });
  }
  let executed = null;
  if (verdict.decision === DECISION.ALLOW) {
    executed = await append(db, {
      run_id: runId, actor: 'gateway', actor_kind: 'system', kind: 'result', action,
      decision: 'EXECUTED', reason: 'performed by the gateway after an ALLOW verdict',
      payload: { intent_seq: intent.seq, ...(verdict.followups?.length ? { followups_due: verdict.followups } : {}) },
    });
  }
  return { intent, verdict, executed, ...verdict };
}

// keep regulated payload text out of the ledger; locator only
function redactArgs(db, args) {
  const a = JSON.parse(JSON.stringify(args ?? {}));
  if (a.body && /NRIC|patient|bank account|home address/i.test(a.body)) a.body = '[redacted body containing personal data]';
  return a;
}
