// src/classify.mjs — content-only sensitivity classifier.
//
// Two-stage, both defensible without a model:
//   1. docType sets the FLOOR, taken from the taxonomy's own example lists.
//   2. content signals set the CEILING; highest rank wins ("a file is as sensitive
//      as its most sensitive line").
//
// It is blind to the file's own `sensitivity:` header on purpose. That header is
// the answer key (ground_truth_labels.json scores against it). A classifier that
// read it would be a lookup, not a control — and a mislabelled file is an attack
// path, so declared-vs-derived disagreement is reported as a finding.
//
// Calibration decisions are recorded in docs/CALIBRATION.md with reasons.

import { createHash } from 'node:crypto';
import { LEVELS, append } from './log.mjs';

const RANK = LEVELS;
export const levelOf = (r) => Object.keys(RANK).find((k) => RANK[k] === r);
export const rankOf = (l) => (l == null ? -1 : RANK[l] ?? -1);

// --- doc types, sourced from taxonomy.json "examples" -----------------------
const DOCTYPES = [
  { type: 'contact_list', floor: 'regulated', re: /contact details|lifetime value|,\s*email,|phone,|email,phone|(?:name,.*(?:email|phone))/i },
  { type: 'owner_records', floor: 'regulated', re: /owner'?s personal records|emergency contact|home address|passport, cpf/i },
  { type: 'payment_credentials', floor: 'regulated', re: /bank and payment details|card on file|account:.*\d{3}-\d{5}/i },
  { type: 'owner_financials', floor: 'regulated', re: /bank balance|personal loan repayment|owner'?s private notes/i },
  // mention of patient data is not possession of it: a contract that bans storing
  // patient data is client-confidential, an export containing it is regulated.
  { type: 'patient_data', floor: 'regulated', re: /patient_name.{0,40}(nric|phone)|columns?:.*patient_name|reason_for_visit[^\n]*|\d+ rows/i },
  { type: 'contract', floor: 'client-confidential', re: /services agreement|agreement dated|appendix a|clause \d/i },
  { type: 'proposal', floor: 'client-confidential', re: /\bproposal\b|\bquote for\b|prepared for .*, \d{1,2} \w+ \d{4}|term sheet/i },
  { type: 'call_notes', floor: 'client-confidential', re: /call notes?|meeting notes?|said on the call|discussed:/i },
  { type: 'invoice_issued', floor: 'internal', re: /\binvoice 20\d\d-\d+\b|bill to:|lumen studio · invoice/i },
  { type: 'supplier_list', floor: 'internal', re: /supplier list|suppliers? and terms/i },
  { type: 'weekly_plan', floor: 'internal', re: /weekly plan|w16|mon:.*tue:|mon:\s/i },
  { type: 'payment_reminder', floor: 'internal', re: /payment reminder|just following up on invoice|overdue since|friendly reminder/i },
  { type: 'price_list', floor: 'public', re: /price list|rates from \d|packages/i },
  { type: 'website_copy', floor: 'public', re: /about (?:us|lumen)|we (?:are|help) |studio founded/i },
  { type: 'case_study', floor: 'public', re: /case study|approved for publication/i },
  { type: 'vendor_marketing', floor: 'public', re: /free for \d+ days|no card required|upgrade your plan|sign up today/i },
];

// --- content signals --------------------------------------------------------
const SIGNALS = [
  { level: 'regulated', re: /\b[STFstf]\d{7}[A-Za-z]\b/, why: 'NRIC-format identifier present' },
  { level: 'regulated', re: /card on file|ending \d{4}, expiry|cvv|card number/i, why: 'payment card details' },
  { level: 'regulated', re: /\baccount:?\s*[A-Z]{0,4}\s*0*\d{2,3}-0*\d{5,}/i, why: 'bank account number' },
  { level: 'regulated', re: /reason_for_visit|hypertension|diagnosis|medical condition|patient_name|clinical note/i, why: 'health information' },
  { level: 'regulated', re: /home address|#\d{2}-\d{2},?\s*(?:Singapore\s*)?\d{6}\b/i, why: 'home address' },
  { level: 'regulated', re: /\bNRIC\b|\bCPF\b|passport number/i, why: 'national identifier present' },
  { level: 'regulated', re: /personal data under the PDPA|regulated personal data|personal data\b(?!.{0,20}\bclause\b)/i, why: 'PDPA personal data' },
  { level: 'regulated', re: /personal loan repayment|bank balance \d/i, why: "owner's private financial position" },
  { level: 'regulated', re: /^(?=.*[A-Z][a-z]{2,}(?: [A-Z][a-z]{1,}){1,3})(?=.*(\+65\s*\d{4}\s*\d{4}|9\d{3} ?\d{4})).*$/, why: 'named person with phone number' },

  { level: 'client-confidential', re: /\bnda\b|non-disclosure|strictly confidential|unaudited financials|fundraising target|pre-money|round isn.?t public|not to be shared with any third party/i, why: 'client commercial sensitivity stated' },
  { level: 'client-confidential', re: /not public|unannounced|keep (?:the |this |it )?.{0,30}to yourself|keep.{0,24}quiet|do not (?:share|discuss)|not for sharing/i, why: 'explicit do-not-share instruction' },
  { level: 'client-confidential', re: /\b(?:contract|agreement)\b.{0,40}\b(?:fee|surcharge|liability|term)\b|\b(?:fee|surcharge|liability)\b.{0,40}\b(?:contract|agreement)\b/i, why: 'contract terms quoted' },

  { level: 'internal', re: /\binvoice\b|\bbill to\b|credit note|status:\s*unpaid|payables?:/i, why: "the business's own billing record" },
  { level: 'internal', re: /\bsupplier\b|purchase order|confirm by friday/i, why: 'supplier / procurement' },
  { level: 'internal', re: /\b(?:to-?do|reminder|chase|decision due)\b|^(?:mon|tue|wed|thu|fri):/i, why: 'internal plan or reminder' },
];

const NEGATE = /anonymised|no patient-identifiable|must not be stored|without.{0,20}consent/i;
const PUBLICATION_OK = /approved for publication|cleared for publication|publishable/i;
const INVOICE_DOC = (t) => /invoice 20\d\d-\d+|bill to:/i.test(t);

export function stripHeader(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const declared = m ? (/^sensitivity:\s*([\w-]+)\s*$/im.exec(m[1])?.[1] ?? null) : null;
  return { body: m ? text.slice(m[0].length) : text, declared, header: m ? m[1] : '' };
}

export function classify(path, text) {
  const { body, declared, header } = stripHeader(text);
  const title = (/^title:\s*(.*)$/im.exec(header)?.[1] ?? '').trim();
  const head = `${title} ${body.split(/\r?\n/).slice(0, 4).join(' ')}`;

  const fired = [];
  const add = (lvl, why, where, kind = 'content') => {
    fired.push({ level: lvl, why, where, kind, rank: RANK[lvl] });
  };

  // 1. doc types -> floor
  const types = DOCTYPES.filter((d) => d.re.test(head) || d.re.test(body)).map((d) => d.type);
  let floor = 0;
  for (const d of DOCTYPES) if (types.includes(d.type)) {
    if (RANK[d.floor] > floor) floor = RANK[d.floor];
    add(d.floor, `document type: ${d.type}`, 'doctype', 'doctype');
  }

  // 2. content -> ceiling, line by line, with negation guard
  let ceiling = floor;
  body.split(/\r?\n/).forEach((ln, i) => {
    if (!ln.trim()) return;
    const negated = NEGATE.test(ln);
    for (const s of SIGNALS) {
      if (!s.re.test(ln)) continue;
      if (negated && RANK[s.level] >= RANK['regulated']) continue;   // describing a ban is not containing data
      if (INVOICE_DOC(body) && s.level === 'regulated' && /account number|payment card|PDPA/.test(s.why)) {
        add('internal', `own receiving details on an outbound invoice (not third-party data): ${s.why}`, `L${i + 1}`);
        continue;
      }
      add(s.level, s.why, `L${i + 1}`);
      if (RANK[s.level] > ceiling) ceiling = RANK[s.level];
    }
  });

  let rank = Math.max(floor, ceiling);

  // published marketing collateral naming a client is public because the client said so
  if (PUBLICATION_OK.test(body) && rank > RANK.public && !/\b[STF]\d{7}[A-Za-z]\b|reason_for_visit/i.test(body)) {
    rank = RANK.public;
    add('public', 'client approved the material for publication', 'text');
  }
  // an inbound vendor marketing email is public: no client or business data in it
  if (types.includes('vendor_marketing') && rank < RANK.internal) rank = RANK.public;

  return {
    path, title, declared, derived: levelOf(rank), rank, docTypes: types,
    signals: fired.sort((a, b) => b.rank - a.rank || (a.kind === 'doctype' ? -1 : 1)),
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
  };
}

export async function ingest(db, readFile) {
  const out = [];
  for (const { path, text } of await readFile()) {
    const c = classify(path, text);
    await db.query(
      `insert into files(path,bytes,sha256,declared_level,derived_level,derived_rank,score_card,classified_at)
       values($1,$2,$3,$4,$5,$6,$7::jsonb,now())
       on conflict(path) do update set bytes=excluded.bytes,sha256=excluded.sha256,
         declared_level=excluded.declared_level,derived_level=excluded.derived_level,
         derived_rank=excluded.derived_rank,score_card=excluded.score_card,classified_at=now()`,
      [c.path, c.bytes, c.sha256, c.declared, c.derived, c.rank, JSON.stringify(c.signals)]);
    out.push(c);
  }
  return out;
}

export async function logDisagreements(db, results, runId) {
  const bad = results.filter((r) => r.declared && r.declared !== r.derived);
  for (const r of bad) {
    await append(db, {
      run_id: runId, actor: 'oversight', actor_kind: 'oversight', kind: 'finding',
      data_level: r.declared, rules: ['taxonomy'],
      reason: `${r.path} declares "${r.declared}" but its content reads as "${r.derived}"`,
      evidence: [{ path: r.path, quote: r.signals.slice(0, 3).map((s) => s.why).join('; ') }],
      payload: { finding: 'label_disagreement', declared: r.declared, derived: r.derived },
    });
  }
  return bad;
}
