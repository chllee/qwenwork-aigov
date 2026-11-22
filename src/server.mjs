// src/server.mjs — workstation HTTP layer. Node core only: no framework, no DB.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, AREAS, ensure, place, placeStream, tree, cat, departures, assertRel, VERBS } from './world.mjs';
import fsp from 'node:fs/promises';
import { init as initJournal, emit, recent, verify } from './journal.mjs';
import { act, mint } from './dispatch.mjs';

ensure(); initJournal();
const UI = path.join(process.cwd(), 'ui');
const MODE = process.env.KAGI_MODE === 'gated' ? 'gated' : 'passthrough';

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj, null, 2)); };
const bad = (res, e) => send(res, e.code === 'E_PATH' || e.code === 'ENOENT' ? 400 : 400, { error: e.message, code: e.code || 'E' });

const routes = {
  'GET /api/info': async () => ({ world: ROOT, areas: AREAS, verbs: Object.keys(VERBS),
    mode: MODE, gate: MODE === 'gated' ? 'attached' : 'NOT ATTACHED — actions run unchecked',
    note: 'uploads stream to docs/ as a human would leave them; the journal records every intent' }),
  'GET /api/world': async () => ({ root: ROOT, tree: await tree('.') }),
  'POST /api/session': async (b) => ({ token: mint(b.actor || 'agent.' + Math.random().toString(36).slice(2, 6), b.label || 'unlabelled'), actor: b.actor }),
  'POST /api/action': async (b, req) => {
    if (!b.token) return { error: 'no principal token issued', code: 'E_AUTH' };
    return act(b.token, { verb: b.verb, args: b.args || {}, session: b.session || 's0' });
  },
  'GET /api/journal': async (q) => ({ session: q.session || null, mode: MODE, rows: await recent(q.session || null, Number(q.limit) || 50) }),
  'GET /api/verify': async () => verify(),
  'GET /api/state': async () => departures(),
  'GET /api/file': async (q) => { try { return await cat(q.path); } catch (e) { return { error: e.message }; } },

  // Staging reads a directory on the server's own disk, which is the one place this
  // app could be talked into leaking files from. So the source is confined to roots
  // an operator declared at launch (KAGI_CORPUS, plus the repo working dir) — not to
  // whatever a browser puts in a query string.
  'POST /api/stage': async (b, q) => {
    const allowed = [process.cwd(), ...(process.env.KAGI_CORPUS || '').split(path.delimiter).filter(Boolean)].map((d) => path.resolve(d));
    const want = path.resolve(q.src || b.src || allowed[0]);
    if (!allowed.some((a) => want === a || want.startsWith(a + path.sep)))
      return { error: `stage source refused: ${want} is outside the declared corpus roots`, hint: 'start with KAGI_CORPUS=/path/to/corpus', code: 'E_PATH' };
    const found = [];
    const walk = async (dir, pre = '') => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const rel = pre ? `${pre}/${e.name}` : e.name;
        if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') await walk(path.join(dir, e.name), rel);
        else if (e.isFile() && /\.(md|csv|txt)$/.test(e.name)) found.push([rel, path.join(dir, e.name)]);
      }
    };
    // The kit ships policy, taxonomy, scenarios and answer keys next to its data. Those
    // are the scorer's material: letting them into the world would put the answer key
    // inside the thing being graded, and let a future gate read labels it must derive.
    const SCORER = /(^|[\/])(policy|taxonomy|scenarios|ground_truth_labels|00_README|README)(\.[a-z]+)?$/i;
    try { await walk(want); } catch (e) { return { error: 'cannot read ' + want + ': ' + e.code }; }
    const kept = found.filter(([rel]) => !SCORER.test(rel));
    const withheld = found.filter(([rel]) => SCORER.test(rel)).map(([rel]) => rel);
    found.length = 0; found.push(...kept);
    let bytes = 0, files = 0; const errs = [];
    for (const [rel, full] of found) {
      try { const r = await placeStream({ rel: 'docs/' + rel, stream: (await import('node:fs')).createReadStream(full), by: 'mei.tan', note: 'staged from ' + path.basename(want) }); bytes += r.bytes; files++; }
      catch (e) { errs.push(`${rel}: ${e.message}`); }
    }
    return { files, bytes, source: want, withheld_from_world: withheld, refused: errs.slice(0, 6) };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://w');
  const key = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-upload-path,x-upload-actor' }); return res.end(); }

  // streaming upload: the body goes to disk, it is never assembled as a string
  if (key === 'POST /api/upload') {
    try {
      const rel = decodeURIComponent(url.searchParams.get('path') || req.headers['x-upload-path'] || '');
      const by = req.headers['x-upload-actor'] || 'mei.tan';
      return send(res, 200, await placeStream({ rel, stream: req, by }));
    } catch (e) { return bad(res, e); }
  }

  const r = routes[key];
  if (r) {
    let payload = {};
    if (req.method === 'POST') { const body = await read(req); try { payload = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'body is not JSON' }); } }
    try { return send(res, 200, await r(payload, Object.fromEntries(url.searchParams))); } catch (e) { return bad(res, e); }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const f = path.join(UI, 'index.html');
    if (!existsSync(f)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>Kagi workstation</h1><p>ui/index.html missing</p>'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(readFileSync(f));
  }
  const asset = path.join(UI, 'kagi.css');
  if (req.method === 'GET' && url.pathname === '/kagi.css' && existsSync(asset)) { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(readFileSync(asset)); }
  send(res, 404, { error: 'no route', tried: key });
});

const read = (req) => new Promise((ok, no) => { let s = '', n = 0; req.on('data', (c) => { n += c.length; if (n > 1 << 22) return no(new Error('body too large')); s += c; }); req.on('end', () => ok(s)); req.on('error', no); });

export function listen(port = Number(process.env.PORT || 3000)) {
  return new Promise((res) => server.listen(port, () => {
    const actual = server.address().port;
    console.log(`\n  kagi workstation  ·  http://localhost:${actual}\n  world: ${ROOT}\n  mode : ${MODE}${MODE === 'passthrough' ? '  (no gate attached — actions run unchecked)' : ''}\n`);
    res({ server, port: actual, close: () => new Promise((r) => server.close(r)) });
  }));
}

// auto-start only when this file is the program, never when a test imports it
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  listen().catch((e) => { console.error(`  cannot listen: ${e.code || e.message}`); process.exit(1); });
}
