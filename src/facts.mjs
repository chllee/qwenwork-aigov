// src/facts.mjs — turn prose and tables into line-addressable values.
//
// This is what makes "check the agent's numbers against the evidence it had"
// mechanical instead of vibes-based. Every figure in the corpus gets a row with a
// locator (file + line), so a verdict can point at "invoice_2026-036 L10: 5,040"
// rather than assert an opinion.

import { loadDataFiles } from './fsio.mjs';

const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const WD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };

export const toNum = (s) => {
  const t = String(s).trim().toLowerCase();
  if (/^[a-z]+$/.test(t)) return WD[t] ?? null;
  const n = Number(t.replace(/,/g, '').replace(/^(?:sgd|s\$)\s?/, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
};
export const money = (n) => 'SGD ' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
/** a value is only meaningful with its unit: 20% is not SGD 20, 2 days is not SGD 2 */
export const fmt = (n, unit = 'money') => unit === 'pct' ? `${Number(n)}%`
  : unit === 'days' ? `${Number(n)} day${Number(n) === 1 ? '' : 's'}`
  : unit === 'count' ? `${Number(n)} units`
  : unit === 'month' ? `${Number(n)} (date)` : money(n);

const PATTERNS = [
  { unit: 'pct', re: new RegExp(String.raw`(\d{1,3}(?:\.\d+)?)\s*%`, 'gi') },
  { unit: 'days', re: new RegExp(String.raw`\b(\d{1,3}|${Object.keys(WD).join('|')})\s+days?\b`, 'gi') },
  { unit: 'units', re: new RegExp(String.raw`\b(\d{1,4})\s+(?:extra\s+)?(?:units?|copies|pcs)\b`, 'gi') },
  { unit: 'SGD', re: new RegExp(String.raw`(?:SGD|S\$)\s?(${NUM})`, 'gi') },
  { unit: 'month', re: new RegExp(String.raw`\b(1[0-2]|0?[1-9])\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b`, 'gi') },
  { unit: 'num', re: new RegExp(String.raw`(?<![\w.,$-])(${NUM})(?!\s*(?:%|days?\b|units?\b|copies\b|rows?\b|Jul|Jan|Feb|Mar|Apr|May|Jun|Aug|Sep|Oct|Nov|Dec|\d))`, 'gi') },
];

const FIELD_BEFORE = new RegExp(String.raw`([A-Za-z][A-Za-z '/&().-]{2,40}?)[:\-–]\s*$`);

function fieldFor(line) {
  // markdown table: | Rush surcharge ... | 840 |
  if (/^\s*\|/.test(line) && !/^\s*\|?\s*:?-{2,}/.test(line)) {
    const cells = line.split('|').map((c) => c.replace(/\*\*/g, '').trim()).filter((c) => c !== '');
    if (cells.length >= 2) {
      const label = cells.find((c) => !toNumIsNum(c)) || cells[0];
      return label.length > 46 ? label.slice(0, 46) : label;
    }
  }
  return null;
}
function toNumIsNum(c) { return toNum(c.replace(/^(?:SGD|S\$)\s?/i, '').replace(/%$/, '')) !== null && /\d/.test(c); }

/** All values with a locator. `context` is the whole line, for citation. */
export function extractFromText(path, text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const tblField = fieldFor(line);
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) {
        const value = toNum(m[1]);
        if (value === null || !Number.isFinite(value)) continue;
        const before = line.slice(0, m.index);
        const field = tblField ?? before.match(FIELD_BEFORE)?.[1]?.trim().replace(/\b(and|or)\s+$/i, '') ?? null;
        if (/^\|?\s*(item|amount \(sgd\))\s*\|?$/i.test(line)) continue; // table header row
        out.push({
          path, line: i + 1, locator: `L${i + 1}`, field: field ? field.replace(/^[-|·\s]+/, '') : null,
          raw: m[0].trim(), value, unit: p.unit === 'num' ? (/\./.test(m[1]) ? 'num' : 'amount') : p.unit, context: line.slice(0, 160),
        });
      }
    }
  });
  // de-dup overlaps: "SGD 5,040" is matched by both the SGD pattern and the bare-number
  // pattern. One fact per (file, line, value, unit-class).
  const cls = (u) => (u === 'SGD' || u === 'num' || u === 'amount' ? 'amount' : u);
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.path}|${f.line}|${f.value}|${cls(f.unit)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    if (cls(f.unit) === 'amount') f.unit = /^\s*(?:SGD|S\$)/i.test(f.raw) ? 'SGD' : 'amount';
    return true;
  });
}

export async function extractAll(db) {
  await db.exec('delete from facts');
  await db.exec('delete from lines');
  let n = 0;
  for (const { path, text } of loadDataFiles()) {
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    body.split(/\r?\n/).forEach((ln, i) => {
      if (ln.trim().length < 3) return;
      db.query(`insert into lines(path,line_no,locator,text) values($1,$2,$3,$4)`, [path, i + 1, `L${i + 1}`, ln.trim().slice(0, 300)]);
    });
    const facts = extractFromText(path, text);
    for (const f of facts) {
      await db.query(
        `insert into facts(path,locator,field,raw,value,unit,context) values($1,$2,$3,$4,$5,$6,$7)`,
        [f.path, f.locator, f.field, f.raw, f.value, f.unit, f.context]);
      n++;
    }
  }
  return n;
}

/** Which files carry this value, and where. */
export async function findValue(db, value) {
  const r = await db.query(
    `select path,locator,field,raw,unit,context from facts where value = $1 order by path`, [value]);
  return r.rows;
}

/** Obligations the owner wrote down in prose rather than in policy.json.
 *  Patterns span line breaks, because real files wrap mid-sentence. */
export const OBLIG_RE = [
  { kind: 'price_floor', re: /floor(?: is)?[^.\n]{0,20}?(?:SGD|S\$\s?)?(\d[\d,]*)/gi, note: 'owner-stated floor' },
  { kind: 'price_floor', re: /do not (?:take on|go below)[^.\n]{0,30}?(?:SGD|S\$\s?)?(\d[\d,]*)/gi, note: 'owner-stated floor' },
  { kind: 'written_confirmation_required', re: /only if ([A-Z][a-z]+) confirms in writing/gi, note: 'needs written confirmation' },
  { kind: 'no_retaining_tool', re: /(ai\s+tools?\s+that\s+retain\s+data|not\s+to\s+be\s+shared\s+with\s+any\s+third\s+party)/gi, note: 'third-party / retaining-tool ban' },
  { kind: 'action_required', re: /must\s+be\s+deleted\s+and\s+reported\s+within\s+(\d+)\s+hours/gi, note: 'contractual action with a clock' },
  { kind: 'settlement_option', re: /(?:accept|settle\s+at)\s+(?:SGD|S\$\s?)?(\d[\d,]*)/gi, note: 'owner decision pending on a figure' },
  { kind: 'hold_option', re: /hold\s+at\s+(?:SGD|S\$\s?)?(\d[\d,]*)/gi, note: 'alternative owner decision on a figure' },
];

export async function mineObligations(db) {
  await db.exec(`delete from obligations where status = 'mined'`);
  const found = [];
  for (const { path, text } of loadDataFiles()) {
    for (const row of OBLIG_RE) {
      row.re.lastIndex = 0;
      let m;
      while ((m = row.re.exec(text))) {
        const line = text.slice(0, m.index).split('\n').length;
        const quote = (text.split('\n')[line - 1] ?? m[0]).replace(/^---$|^title:.*$/gi, '').trim() || m[0].trim();
        const params = { raw: m[0].replace(/\s+/g, ' ').trim(), note: row.note };
        if (/^\d[\d,]*$/.test(m[1] ?? '')) params.value = toNum(m[1]);
        if (/^[A-Z][a-z]+$/.test(m[1] ?? '')) params.who = m[1];
        found.push({ kind: row.kind, source_path: path, source_quote: quote.slice(0, 140), source_line: `L${line}`, params });
      }
    }
  }
  for (const f of found) {
    const id = `OBL-${f.kind}-${f.source_path.replace(/\W+/g, '_').slice(-26)}-l${f.source_line}`;
    const linked = { price_floor: 'R08', written_confirmation_required: 'R12', no_retaining_tool: 'R15',
                     action_required: 'R17', settlement_option: 'R09', hold_option: 'R09' }[f.kind] ?? null;
    await db.query(
      `insert into obligations(id,kind,params,source_path,source_quote,status,linked_rule)
       values($1,$2,$3::jsonb,$4,$5,'mined',$6)
       on conflict(id) do update set params=excluded.params, source_quote=excluded.source_quote, linked_rule=excluded.linked_rule`,
      [id, f.kind, JSON.stringify(f.params), f.source_path, f.source_quote, linked]);
  }
  return found;
}

export async function obligations(db) {
  return (await db.query('select * from obligations order by kind, source_path')).rows.map((r) => ({
    ...r, params: typeof r.params === 'string' ? JSON.parse(r.params) : r.params,
  }));
}
