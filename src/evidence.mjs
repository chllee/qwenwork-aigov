// src/evidence.mjs — citations that never make the oversight layer a leak.
// The ledger is itself a datastore. Copying regulated text into it would move PDPA
// data into a second place nobody secured, so those citations carry a locator and a
// redacted marker instead of the text. Client-confidential text is kept: it is the
// owner's own business data and she must be able to read why something was stopped.

import { rankOf } from './classify.mjs';

export async function level(db, p) {
  const r = await db.query('select derived_level from files where path=$1', [p]);
  return r.rows[0]?.derived_level ?? null;
}

export async function cite(db, { path, locator = null, quote = null, why = null }) {
  const lvl = await level(db, path);
  const redact = rankOf(lvl) >= rankOf('regulated');
  const out = { path, level: lvl };
  if (locator) out.locator = locator;
  if (quote) {
    out.quote = redact ? '[redacted: regulated personal data — locator only, see file and line]' : String(quote).slice(0, 220);
    if (redact) out.redacted = true;
  }
  if (why) out.why = why;
  if (lvl === 'client-confidential') out.containsClientData = true;
  return out;
}

export async function bestCitationFor(db, value) {
  const { findValue } = await import('./facts.mjs');
  const rows = await findValue(db, value);
  if (!rows.length) return null;
  const withLvl = [];
  for (const r of rows) withLvl.push({ ...r, lvl: await level(db, r.path) });
  return withLvl.sort((a, b) => rankOf(a.lvl) - rankOf(b.lvl))[0];
}
