// src/world.mjs — the agent's work surface, as real bytes on real disk.
//
// The rule this module exists to enforce: an action either changes the world or it
// does not. Nothing may claim something happened unless a file moved. Everything
// else in this system is arguable; this is what the argument has to be about.
//
//   WORLD_ROOT/
//     docs/                 the owner's files, uploaded at runtime by a human
//     docs/.reads/          per-actor read receipts (the brief's "which files were read")
//     drafts/               agent-authored outgoing mail, not yet sent
//     outbox/               what actually left the studio by email
//     egress/<tool>/        what actually left the studio to an external tool
//     trash/                what was deleted, with its prior path recorded
//     world.json            provenance of every byte that entered the world

import fs from 'node:fs';
import fsp from 'node:fs/promises';
const fsPromises = fsp;
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(process.env.WORLD_ROOT || path.join(process.cwd(), 'world'));
export const AREAS = ['docs', 'drafts', 'outbox', 'egress', 'trash'];
const AREA_DIR = Object.fromEntries(AREAS.map((a) => [a, path.join(ROOT, a)]));
const INDEX = path.join(ROOT, 'world.json');

// A tool may only ever name one of these areas, normalised, no traversal, no
// absolute paths, no separators other than '/', no NUL. Everything else dies here
// regardless of what the caller intended.
const SAFE = /^(docs|drafts|outbox|egress|trash)(\/[^/\0]{1,140})+$/;

export function assertRel(p) {
  if (typeof p !== 'string') throw badPath(p, 'not a string');
  if (p.includes('\\') || p.includes('\0')) throw badPath(p, 'separator or NUL');
  const norm = path.posix.normalize(p);
  if (norm !== p || norm.includes('..')) throw badPath(p, 'not normalised');
  if (!SAFE.test(norm)) throw badPath(p, 'area or shape not permitted');
  return norm;
}
const badPath = (p, why) => Object.assign(new Error(`path rejected (${why}): ${JSON.stringify(String(p).slice(0, 80))}`), { code: 'E_PATH' });

export const abs = (rel) => path.join(ROOT, assertRel(rel));
const sha = (b) => crypto.createHash('sha256').update(Buffer.isBuffer(b) ? b : String(b)).digest('hex');
const now = () => new Date().toISOString();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

export function ensure() {
  for (const d of Object.values(AREA_DIR)) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(INDEX)) fs.writeFileSync(INDEX, JSON.stringify({ files: {} }, null, 2));
}
export const index = () => JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const saveIndex = (i) => fs.writeFileSync(INDEX, JSON.stringify(i, null, 2));

/** The single entry point for a human putting bytes into the world. */
export async function place({ rel, body, by = 'mei.tan', note = '' }) {
  const clean = path.posix.normalize(String(rel || ''));
  if (!/^docs(\/[\w ().,'-]{1,120})+$/.test(clean) || clean.includes('..')) throw badPath(rel, 'uploads must land under docs/');
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const target = path.join(ROOT, clean);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buf);
  const i = index();
  i.files[clean] = { sha256: sha(buf), bytes: buf.length, placed_at: now(), placed_by: by, note };
  saveIndex(i);
  return { path: clean, bytes: buf.length, sha256: sha(buf) };
}

export async function exists(rel) {
  const r = assertRel(rel);
  return !!(await fsp.stat(path.join(ROOT, r)).catch(() => null));
}

// ------------------------------------------------------------------ the five verbs
/** Reads <file>. Logged with a read receipt, because the brief asks "which files were read". */
export async function read_file({ rel, actor }) {
  const r = assertRel(rel);
  const st = await fsp.stat(path.join(ROOT, r)).catch(() => null);
  if (!st) throw Object.assign(new Error(`not found: ${r}`), { code: 'ENOENT' });
  const text = await fsp.readFile(path.join(ROOT, r), 'utf8');
  let receipt = null;
  if (r.startsWith('docs/') && !r.startsWith('docs/.reads/')) {
    const dir = path.join(AREA_DIR.docs, '.reads');
    await fsp.mkdir(dir, { recursive: true });
    receipt = `docs/.reads/${slug(actor)}.log`;
    await fsp.appendFile(path.join(ROOT, receipt), `${now()}\t${actor}\t${r}\tsha=${sha(text).slice(0, 12)}\n`);
  }
  return { ok: true, path: r, bytes: st.size, text, provenance: index().files[r] || null, receipt };
}

/** Lists a directory: names and sizes, contents deliberately withheld. */
export async function list_dir({ rel }) {
  const area = String(rel ?? '.').replace(/\/+$/, '');
  if (area !== '.' && !AREAS.includes(area)) assertRel(`${area}/x`);
  const base = area === '.' ? ROOT : path.join(ROOT, area);
  const out = [];
  const walk = async (dir, from) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name === 'world.json') continue;
      const r = from ? `${from}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push({ path: `${r}/`, type: 'dir' }); await walk(path.join(dir, e.name), r); }
      else out.push({ path: r, type: 'file', bytes: (await fsp.stat(path.join(dir, e.name)).catch(() => ({ size: 0 }))).size });
    }
  };
  await walk(base, area === '.' ? '' : area);
  if (area === '.') return { ok: true, listing: AREAS.map((a) => `${a}/`) };
  return { ok: true, listing: out };
}

/** delete_file(path) — a real removal into trash/, not a soft flag. S3 turns on this distinction. */
export async function delete_file({ rel, actor, reason = '' }) {
  const r = assertRel(rel);
  if (r.startsWith('docs/.reads/')) throw Object.assign(new Error('read receipts are not deletable'), { code: 'E_PROTECTED' });
  const st = await fsp.stat(path.join(ROOT, r)).catch(() => null);
  if (!st) throw Object.assign(new Error(`not found: ${r}`), { code: 'ENOENT' });
  const bytes = await fsp.readFile(path.join(ROOT, r));
  const dest = path.join(AREA_DIR.trash, `${Date.now()}-${slug(r)}.json`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, JSON.stringify({
    deleted_from: r, deleted_by: actor, deleted_at: now(), reason,
    sha256: sha(bytes), bytes: bytes.length, content: bytes.toString('utf8'),
  }, null, 2));
  await fsp.unlink(path.join(ROOT, r));
  const i = index();
  if (i.files[r]) Object.assign(i.files[r], { deleted_at: now(), deleted_by: actor });
  saveIndex(i);
  return { ok: true, deleted: r, trash: path.relative(ROOT, dest), bytes: bytes.length };
}

/** send_email. A draft is a file; a SENT mail is a second file in outbox/. Both are true on disk. */
export async function send_email({ to, subject = '', body, actor, thread = '', deliver = true }) {
  if (!/^[^@\s]+@[\w.-]+$/.test(String(to || ''))) throw Object.assign(new Error('send_email: recipient must be an address'), { code: 'E_ARGS' });
  if (!String(body || '').trim()) throw Object.assign(new Error('send_email: empty body'), { code: 'E_ARGS' });
  const party = String(to).split('@')[1].toLowerCase();
  const id = `${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const em = { message_id: `<${id}@lumenstudio.local>`, from: 'mei@lumenstudio.example', to: String(to),
    subject: String(subject), body: String(body), thread_ref: thread, composed_by: actor, composed_at: now() };
  const name = `${em.composed_at.slice(0, 10)}-${slug(party)}-${id.slice(-8)}.json`;
  const json = JSON.stringify(em, null, 2);
  await fsp.mkdir(path.join(AREA_DIR.drafts, party), { recursive: true });
  await fsp.writeFile(path.join(AREA_DIR.drafts, party, name), json);
  let sent = null;
  if (deliver) {
    await fsp.mkdir(path.join(AREA_DIR.outbox, party), { recursive: true });
    await fsp.writeFile(path.join(AREA_DIR.outbox, party, name), json);
    sent = `outbox/${party}/${name}`;
  }
  return { ok: true, message_id: em.message_id, to: em.to, draft: `drafts/${party}/${name}`, sent, delivered: !!sent };
}

/** upload_to_external_tool(target, file) — the bytes genuinely leave the building. */
export async function upload_to_external_tool({ target, rel, actor, purpose = '' }) {
  const r = assertRel(rel);
  const t = String(target || '').toLowerCase();
  if (!/^[\w.-]+\.[a-z]{2,}$/.test(t)) throw Object.assign(new Error(`upload: bad target ${JSON.stringify(target)}`), { code: 'E_ARGS' });
  const buf = await fsp.readFile(path.join(ROOT, r)).catch(() => null);
  if (!buf) throw Object.assign(new Error(`not found: ${r}`), { code: 'ENOENT' });
  const dir = path.join(AREA_DIR.egress, slug(t));
  await fsp.mkdir(dir, { recursive: true });
  const name = `${now().replace(/[:.]/g, '-')}-${path.basename(r)}`;
  await fsp.writeFile(path.join(dir, name), buf);
  const rec = `${name}.receipt.json`;
  await fsp.writeFile(path.join(dir, rec), JSON.stringify({
    tool: t, uploaded_from: r, sha256: sha(buf), bytes: buf.length, uploaded_by: actor, at: now(), purpose,
  }, null, 2));
  return { ok: true, tool: t, egress: `egress/${slug(t)}/${name}`, receipt: `egress/${slug(t)}/${rec}`, bytes: buf.length, sha256: sha(buf) };
}

export const VERBS = { read_file, list_dir, delete_file, send_email, upload_to_external_tool };

/** Everything a judge should be allowed to check without trusting any log line. */
const pathsOf = async (dir) => {
  const out = [];
  const walk2 = async (d, pre) => {
    for (const e of await fsPromises.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) await walk2(path.join(d, e.name), rel);
      else if (e.isFile() && e.name.endsWith('.json')) out.push(rel);
    }
  };
  await walk2(dir, '');
  return out.sort();
};

export async function departures() {
  const mail = [], egress = [], deleted = [], reads = {};
  const j = async (abs) => JSON.parse(await fsPromises.readFile(abs, 'utf8').catch(() => '{}'));
  for (const rel of await pathsOf(AREA_DIR.outbox)) {
    const m = await j(path.join(AREA_DIR.outbox, rel));
    mail.push({ path: `outbox/${rel}`, to: m.to, subject: m.subject || '(no subject)', by: m.composed_by, at: m.composed_at,
      preview: String(m.body || '').replace(/\s+/g, ' ').slice(0, 90) });
  }
  for (const rel of await pathsOf(AREA_DIR.egress)) {
    if (rel.endsWith('.receipt.json')) egress.push(await j(path.join(AREA_DIR.egress, rel)));
  }
  for (const rel of await pathsOf(AREA_DIR.trash)) deleted.push(await j(path.join(AREA_DIR.trash, rel)));
  for (const f of await fsPromises.readdir(path.join(AREA_DIR.docs, '.reads')).catch(() => [])) {
    reads[f.replace(/\.log$/, '')] = (await fsPromises.readFile(path.join(AREA_DIR.docs, '.reads', f), 'utf8')).trim().split('\n').filter(Boolean);
  }
  return { mail, egress, deleted, reads };
}

/** Streaming upload: a request body flows straight to disk. No base64, no string. */
export async function placeStream({ rel, stream, by = 'mei.tan', note = '', cap = 24 * 1024 * 1024 }) {
  const clean = path.posix.normalize(String(rel || ''));
  if (!/^docs(\/[\w ().,'-]{1,120})+$/.test(clean) || clean.includes('..')) throw badPath(rel, 'uploads must land under docs/');
  const target = path.join(ROOT, clean);
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  const { createWriteStream } = await import('node:fs');
  const { finished } = await import('node:stream/promises');
  const out = createWriteStream(target);
  let n = 0;
  stream.on('data', (c) => { n += c.length; if (n > cap) { stream.destroy(); out.destroy(); throw Object.assign(new Error('upload too large'), { code: 'E_LIMIT' }); } });
  stream.pipe(out);
  await finished(out);
  const buf = await fsPromises.readFile(target);
  const i = index();
  i.files[clean] = { sha256: sha(buf), bytes: buf.length, placed_at: now(), placed_by: by, note };
  saveIndex(i);
  return { path: clean, bytes: buf.length, sha256: sha(buf) };
}

/** Flattened view of the whole world: every area, names and sizes, no contents. */
export async function tree() {
  const out = [];
  for (const area of AREAS) {
    const dir = path.join(ROOT, area);
    const walk = async (d, pre) => {
      for (const e of await fsPromises.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const rel = pre ? `${pre}/${e.name}` : e.name;
        if (e.isDirectory()) { out.push({ path: `${rel}/`, type: 'dir' }); await walk(path.join(d, e.name), rel); }
        else if (e.name === 'world.json') continue;
        else {
          const st = await fsPromises.stat(path.join(d, e.name)).catch(() => ({ size: 0 }));
          const inIndex = index().files[`${area}/${rel}`];
          out.push({ path: `${area}/${rel}`, type: 'file', bytes: st.size, placed_by: inIndex?.placed_by || null, sha: inIndex?.sha256?.slice(0, 10) || null, deleted: !!inIndex?.deleted_at });
        }
      }
    };
    await walk(dir, '');
  }
  return out.filter((e) => !e.path.includes('/.reads/') && !e.path.endsWith('world.json')).sort((a, b) => a.path.localeCompare(b.path));
}

/** Read one file for the human-facing viewer. Same path rules as any tool. */
export async function cat(rel) {
  const r = assertRel(rel);
  const st = await fsPromises.stat(path.join(ROOT, r)).catch(() => null);
  if (!st) throw Object.assign(new Error(`not found: ${r}`), { code: 'ENOENT' });
  if (st.size > 2_000_000) throw Object.assign(new Error('file too large to display'), { code: 'E_LIMIT' });
  return { path: r, bytes: st.size, text: await fsPromises.readFile(path.join(ROOT, r), 'utf8'), provenance: index().files[r] || null };
}
