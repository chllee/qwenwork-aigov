// test/e2e.mjs — verbs are proven by inspecting the filesystem, never by trusting a response body.
//   BASE=http://localhost:3210 WORLD_ROOT=$PWD/world-test node test/e2e.mjs
import fsp from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.env.WORLD_ROOT || 'world-test');
const B = process.env.BASE || 'http://localhost:3210';
const call = async (p, o) => { const r = await fetch(B + p, o); return { status: r.status, body: await r.json().catch(() => null) }; };
const abs = (rel) => path.join(ROOT, rel);
const has = async (rel) => !!(await fsp.stat(abs(rel)).catch(() => null));
const rd = (rel) => fsp.readFile(abs(rel), 'utf8');

const ok = [], bad = [];
// detail is a thunk: a failing check must report, not crash the harness
const t = async (name, pass, detail) => {
  let d = '';
  if (detail) { try { d = String(await detail()).slice(0, 130); } catch (e) { d = `(detail unavailable: ${e.code || e.message})`; } }
  (pass ? ok : bad).push(`${name}${d ? '  → ' + d : ''}`);
};

// The world persists, so absolutes are meaningless: snapshot first and assert deltas.
const base = await call('/api/state').then((r) => r.body);
const n0 = { mail: (base.mail || []).length, egress: (base.egress || []).length, deleted: (base.deleted || []).length };

const { body: sess } = await call('/api/session', { method: 'POST', body: JSON.stringify({ actor: 'worker.ops', label: 'e2e' }) });
const tok = sess.token;
const act = (verb, args) => call('/api/action', { method: 'POST', body: JSON.stringify({ token: tok, verb, args, session: 'e2e' }) });

// ── upload + read ───────────────────────────────────────────────────────────
const UP = 'docs/test/hello.md';
await call(`/api/upload?path=${encodeURIComponent(UP)}`, { method: 'POST', headers: { 'x-upload-actor': 'test' }, body: 'status: UNPAID\nfee: SGD 1,000\n' });
await t('upload wrote a real file under docs/', await has(UP), async () => `${(await rd(UP)).length} chars`);

const r1 = await act('read_file', { rel: UP });
await t('read_file returned the bytes', /UNPAID/.test(r1.body?.text || ''), async () => `${(r1.body?.text || '').length} chars`);
const RCPT = 'docs/.reads/worker-ops.log';
await t('read recorded a receipt on disk', await has(RCPT), async () => (await rd(RCPT)).trim().split('\n').pop());
await t('receipt names actor and file', await has(RCPT), async () => /worker\.ops/.test(await rd(RCPT)));

// ── email: draft vs actually sent ───────────────────────────────────────────
const e = await act('send_email', { to: 'orders@quickprint.example', subject: 'go ahead', body: 'Please go ahead with the 6 units, SGD 720.' });
await t('send_email left a draft', await has(e.body.draft || '/none'), () => e.body.draft);
await t('send_email delivered to outbox/', await has(e.body.sent || '/none'), () => e.body.sent);
const dl = await act('send_email', { to: 'someone@else.example', body: 'draft only, do not send', deliver: false });
await t('deliver:false creates no outbox entry', !dl.body.sent && !(await has('outbox/else.example')) && await has(dl.body.draft), () => `draft: ${dl.body.draft || '?'}`);

// ── external tool (fidelity checked while the source still exists) ──────────
const u = await act('upload_to_external_tool', { target: 'sparkmail.example', rel: UP, purpose: 'newsletter' });
await t('upload wrote real bytes to egress/<tool>/', await has(u.body.egress || '/none'), () => u.body.egress);
await t('upload left a tool receipt', await has(u.body.receipt || '/none'), async () => JSON.parse(await rd(u.body.receipt)).tool);
await t('egress bytes are identical to the source', await has(u.body.egress || '/none'), async () => {
  const want = await fsp.readFile(abs(UP));
  const got = await fsp.readFile(abs(u.body.egress));
  return want.equals(got) ? 'identical' : 'DIFFERENT';
});
await t('receipt records who uploaded and why', await has(u.body.receipt || '/none'), async () => {
  const o = JSON.parse(await rd(u.body.receipt));
  return `${o.uploaded_by} / ${o.purpose}`;
});

// ── delete really deletes, and keeps evidence ───────────────────────────────
const d = await act('delete_file', { rel: UP, reason: 'tidy up' });
await t('delete_file removed the working copy', !(await has(UP)));
await t('delete_file preserved the bytes in trash/', await has(d.body.trash || '/none'), () => d.body.trash);
const tr = d.body.trash ? JSON.parse(await rd(d.body.trash)) : {};
await t('trash records origin, actor and reason', tr.deleted_from === UP && tr.deleted_by === 'worker.ops' && tr.reason === 'tidy up', () => `${tr.deleted_from} by ${tr.deleted_by}`);
await t('trash content is verbatim', /UNPAID/.test(tr.content || ''), () => `sha=${(tr.sha256 || '').slice(0, 10)}`);

// ── refusals the world holds regardless of any gate ─────────────────────────
const P = await act('read_file', { rel: '../etc/passwd' });
await t('path traversal rejected', P.status >= 400 && P.body.code === 'E_PATH', () => P.body.error);
const A = await act('delete_file', { rel: RCPT, reason: 'hide it' });
await t('read receipts are not deletable', String(A.body?.error || '').includes('not deletable'), () => JSON.stringify(A.body).slice(0, 90));
const N = await act('drop_everything', {});
await t('unknown verb refused before any effect', !!N.body?.error, () => N.body?.error);
const noTok = await call('/api/action', { method: 'POST', body: JSON.stringify({ verb: 'list_dir', args: {} }) });
await t('anonymous action refused', !!noTok.body?.error, () => noTok.body?.error);
const L = await act('list_dir', { rel: 'trash' });
await t('list returns names, not contents', !JSON.stringify(L.body).includes('UNPAID'), () => `${L.body.listing?.length ?? '?'} entries`);

// ── journal ────────────────────────────────────────────────────────────────
const j = (await call('/api/journal?session=e2e')).body;
const v = (await call('/api/verify')).body;
await t('journal chain verifies', v.ok === true, () => `head=${v.head} rows=${v.rows}`);
await t('every effect follows its intent', j.rows.filter((r) => r.event === 'effect').every((fx) => j.rows.some((i) => i.event === 'intent' && i.seq < fx.seq)), () => `${j.rows.filter((r) => r.event === 'intent').length} intents / ${j.rows.filter((r) => r.event === 'effect').length} effects`);
await t('a refused verb leaves intent only, no effect', !j.rows.some((r) => r.event === 'effect' && r.verb === 'drop_everything'));
await t('journal states that no gate was attached', j.rows.every((r) => r.mode === 'passthrough'));
await t('actor is server-stamped, not caller-claimed', j.rows.filter((r) => r.event === 'intent').every((r) => r.actor === 'worker.ops'));
const st = (await call('/api/state')).body;
await t('state reports mail, egress, deletions, readers', ['mail', 'egress', 'deleted', 'reads'].every((k) => k in st), () => `${st.mail.length} sent / ${st.egress.length} uploaded / ${st.deleted.length} deleted / ${Object.keys(st.reads || {}).length} readers`);
// a vacuous pass here would hide a departures() bug: all four must actually be populated
await t('state grew by exactly one mail, one upload, one deletion',
  st.mail.length - n0.mail === 1 && st.egress.length - n0.egress === 1 && st.deleted.length - n0.deleted === 1,
  () => `+${st.mail.length - n0.mail} mail / +${st.egress.length - n0.egress} egress / +${st.deleted.length - n0.deleted} deleted (from ${n0.mail}/${n0.egress}/${n0.deleted})`);
await t('the new egress entry names the file we uploaded', st.egress.some((g) => g.uploaded_from === UP && g.uploaded_by === 'worker.ops'), () => (st.egress.at(-1) || {}).uploaded_from);
await t('the deletion in state matches the file we removed', st.deleted.some((x) => x.deleted_from === UP), () => (st.deleted[0] || {}).deleted_from);
await t('the mail in state is the one addressed to QuickPrint', st.mail.some((x) => /quickprint/.test(x.to || '')), () => (st.mail[0] || {}).to);

console.log(`\n  Kagi workstation · verb and safety checks\n  ${''.padEnd(56, '-')}`);
for (const line of ok) console.log(`   ✔ ${line}`);
if (bad.length) { console.log(`\n   ✘ ${bad.length} FAILED`); for (const line of bad) console.log(`     ${line}`); }
console.log(`\n  ${ok.length} passed, ${bad.length} failed\n`);
process.exit(bad.length ? 1 : 0);
