// src/server.mjs — the owner's app. Read-mostly, one write path (her decisions),
// and an integrity panel that lets a judge try to break the ledger on stage.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { boot, newRunId, announce } from './boot.mjs';
import { replay, pointsOf } from './replay.mjs';
import { ledger, verifyChain, seal, append, rowHash, canonical } from './log.mjs';
import { buildBriefing } from './briefing.mjs';
import { decide, sweepTimeouts } from './approvals.mjs';
import { ROOT_DIR } from './fsio.mjs';

const { db, policy, roster, scenarios } = await boot();
let runId = (await db.query(`select run_id from events where kind='verdict' order by seq desc limit 1`)).rows[0]?.run_id ?? newRunId();

const j = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { r(s ? JSON.parse(s) : {}); } catch { r({}); } }); });
const parse = (r) => (typeof r === 'string' ? JSON.parse(r || 'null') : r);

const api = {
  'GET /api/runs': async () => (await db.query(`select distinct run_id from events where kind='verdict' order by run_id desc limit 20`)).rows.map((r) => r.run_id),

  'GET /api/summary': async () => {
    const rows = await ledger(db, {});
    const v = rows.filter((r) => r.kind === 'verdict' && r.run_id === runId);
    const pending = await api['GET /api/pending']();
    const scored = (await db.query(`select payload from events where kind='note' and run_id=$1 limit 1`, [runId])).rows[0];
    return {
      runId, policy: { version: policy.version, rules: policy.rules.length, sha: policy.sha.slice(0, 12) },
      counts: {
        actions: v.length, allowed: v.filter((x) => x.decision === 'ALLOW').length,
        held: pending.length, blocked: v.filter((x) => x.decision === 'BLOCK').length,
        findings: rows.filter((r) => r.kind === 'finding').length, ledger_rows: rows.length,
        files: (await db.query('select count(*) n from files')).rows[0].n,
        facts: (await db.query('select count(*) n from facts')).rows[0].n,
        obligations: (await db.query("select count(*) n from obligations where status='mined'")).rows[0].n,
      },
      last_score: scored ? parse(scored.payload)?.score : null,
    };
  },

  'GET /api/ledger': async () => (await ledger(db, {})).map((r) => ({ ...r, rules: parse(r.rules), evidence: parse(r.evidence), payload: parse(r.payload) })).reverse(),
  'GET /api/run_ledger': async () => (await ledger(db, { runId })).map((r) => ({ ...r, rules: parse(r.rules), evidence: parse(r.evidence), payload: parse(r.payload) })),

  'GET /api/pending': async () => {
    const rows = await ledger(db, { runId });
    const answered = new Set(rows.filter((r) => r.kind === 'approval').map((r) => Number(r.approval_for)));
    return rows.filter((r) => r.kind === 'verdict' && r.decision === 'HOLD_FOR_APPROVAL' && !answered.has(r.seq))
      .map((r) => ({ seq: r.seq, ts: r.ts, action: r.action, rules: parse(r.rules), reason: r.reason, evidence: parse(r.evidence), claims: parse(r.payload)?.claims ?? null }));
  },

  'GET /api/briefing': async () => buildBriefing(db, runId),

  'GET /api/integrity': async () => {
    const chain = await verifyChain(db);
    return { ...chain, head: chain.head?.slice(0, 24), rules: (await db.query("select tgname from pg_trigger where tgrelid='events'::regclass")).rows.map((r) => r.tgname), permissions: (await db.query("select data_type from information_schema.columns where table_name='events' and column_name='seq'")).rows.length ? 'insert-only trigger armed' : 'unknown' };
  },

  'POST /api/replay': async () => {
    runId = newRunId();
    await announce(db, runId, policy, roster, 'web');
    const scored = await replay(db, { policy, roster, runId, scenarios });
    return { runId, kit: pointsOf(scored), of: scenarios.filter((s) => !s.our_own).length * 3, ours: scored.filter((r) => r.sc.our_own).length * 3, results: scored.map((r) => ({ id: r.sc.id, name: r.sc.name, our_own: !!r.sc.our_own, ...r.score })) };
  },

  'POST /api/decide': async (b) => {
    const out = await decide(db, { runId: b.runId ?? runId, seq: b.seq, verdict: b.verdict, note: b.note ?? null });
    return out;
  },

  'POST /api/timeout_sweep': async (b) => ({ denied: await sweepTimeouts(db, runId, { maxAgeMinutes: Number(b.maxAgeMinutes ?? 0) }) }),

  // a judge-facing demonstration that the ledger cannot be quietly rewritten
  'POST /api/tamper': async (b) => {
    const tries = [];
    try { await db.query(`update events set decision='ALLOW', reason='(forged) approved' where seq=(select max(seq) from events)`); tries.push({ attempt: 'UPDATE verdict to ALLOW', result: 'WRITTEN — integrity failure' }); }
    catch (e) { tries.push({ attempt: 'UPDATE verdict to ALLOW', result: 'REFUSED by the database: ' + e.message }); }
    try { await db.query(`delete from events where kind='finding'`); tries.push({ attempt: 'DELETE the findings', result: 'WRITTEN — integrity failure' }); }
    catch (e) { tries.push({ attempt: 'DELETE the findings', result: 'REFUSED by the database: ' + e.message }); }
    const last = (await db.query('select * from events order by seq desc limit 1')).rows[0];
    if (last) {
      const altered = { ...last, decision: 'ALLOW', reason: '(forged) the agent was right' };
      const recomputed = rowHash(altered, altered.prev_hash);
      tries.push({
        attempt: 'Rewrite the newest verdict in place and keep it quiet',
        result: recomputed === last.hash
          ? 'FAILED TO DEMONSTRATE — hashes matched'
          : `DETECTED: the row's stored hash is ${last.hash.slice(0, 12)}… but the content now hashes to ${recomputed.slice(0, 12)}…, and every later row carries the old value in its prev_hash`,
      });
    }
    const chain = await verifyChain(db);
    if (!chain.ok) await append(db, { runId, actor: 'oversight', actor_kind: 'oversight', kind: 'note', reason: `integrity alarm: chain broken at event ${chain.brokenAt} (${chain.why})`, decision: 'ALERT' });
    return { tries, chain, note: 'An append-only table plus a hash chain means the worst case is a detected forgery, not a silent one.' };
  },
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  if (api[key]) { try { return j(res, 200, await api[key](req.method === 'POST' ? await body(req) : {})); } catch (e) { return j(res, 500, { error: e.message }); } }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const f = path.join(ROOT_DIR, 'web', 'index.html');
    res.writeHead(200, { 'content-type': 'text/html' }); return createReadStream(f).pipe(res);
  }
  const f = path.join(ROOT_DIR, 'web', url.pathname.replace(/[.]/g, '')); 
  if (existsSync(f) && statSync(f).isFile()) { res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'text/plain' }); return createReadStream(f).pipe(res); }
  j(res, 404, { error: 'not found' });
});
const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Kagi console → http://localhost:${port}   (run ${runId}, policy v${policy.version})`));
