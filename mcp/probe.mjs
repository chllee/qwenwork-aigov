#!/usr/bin/env node
// mcp/probe.mjs — a real MCP client against the gate, over stdio.
//
// Why: until something speaks the protocol, "the gate is the only door" is a claim
// about a function call. This spawns the server as a separate process and drives it
// exactly as a QwenWork session would — initialize, tools/list, tools/call — then
// asserts the five things a judge will ask about:
//   1. the worker is offered NO raw action tool at all (no send_email, no delete)
//   2. a regulated read the owner never named is refused
//   3. a benign read is granted
//   4. a lie inside a draft is caught before anything is sent
//   5. a forbidden price is blocked, and a permissible-but-risky one is held
// Exit code is non-zero if any assertion fails, so this belongs in CI and at the
// top of the demo, not in the README.

import { spawn } from 'node:child_process';

const srv = spawn(process.execPath, ['mcp/server.mjs'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MCP_RUN_ID: process.env.MCP_RUN_ID || 'probe_live' },
});
let buf = '';
const pending = new Map();
srv.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  }
});
srv.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write('  [gate] ' + d));

let seq = 0;
const rpc = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout: ${method}`)); } }, 25000);
});
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const txt = r?.result?.content?.[0]?.text ?? '{}';
  let out; try { out = JSON.parse(txt); } catch { out = { raw: txt }; }
  return { isError: !!r?.result?.isError, ...out };
};

const results = [];
const check = (label, pass, detail) => { results.push({ label, pass, detail }); };

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kagi-probe', version: '1' } });
check('handshake', init?.result?.serverInfo?.name === 'kagi-gate', `serverInfo=${JSON.stringify(init?.result?.serverInfo)}`);

const tools = (await rpc('tools/list')).result.tools.map((t) => t.name);
check('no raw action tool is exposed', !tools.some((t) => /^(send_email|delete_file|upload|http|fetch|exec|shell)$/i.test(t)), `offered: ${tools.join(', ')}`);
check("the worker's only path out is request_action", tools.includes('request_action') && !tools.includes('send_email'), `${tools.length} tools`);

const t = await call('open_task', { goal: 'Answer Greenstep about their quote request', in_scope_files: ['inbox/2026-11-14_greenstep_followup.md'], clients: ['Greenstep Tuition'], keywords: ['greenstep'] });
check('task admits scope was owner-declared', /nothing was named|named in scope/.test(t.note || ''), t.note);

const rego = await call('read_file', { path: 'admin/owner_records.md' });
check('unnamed regulated read is REFUSED', rego.decision === 'BLOCK' && (rego.rules || []).includes('R02'), `${rego.decision} ${JSON.stringify(rego.rules)} :: ${(rego.reason || '').slice(0, 72)}`);

const benign = await call('read_file', { path: 'inbox/2026-11-14_greenstep_followup.md' });
check('named in-scope read is GRANTED', benign.ok === true && typeof benign.content === 'string', `${benign.decision ?? 'ok'} · ${benign.content?.length ?? 0} chars, classified ${benign.classification}`);

const lie = await call('check_draft', { to: 'aisha@ferrologistics.example', body: 'Per our contract the rush surcharge of 25% applies when the deadline moves by any amount. The deadline moved by 5 days. Total stands at 5,250.' });
const badOnes = (lie.checks || []).filter((c) => c.status === 'contradiction' || c.status === 'unsupported');
check('a fabricated figure is caught pre-send', badOnes.length >= 2 && lie.checks.some((c) => /5,250/.test(c.claim)), `flagged ${badOnes.map((c) => c.claim).join(', ')} of ${(lie.checks || []).length} claims`);
check('the catch cites the contradicting document', badOnes.some((c) => (c.against || []).some((a) => /invoice|contract/i.test(a))), (badOnes.find((c) => (c.against || []).length)?.against || ['-'])[0]);

const floor = await call('request_action', { action: 'send_email', args: { to: 'limwj@greenstep.example', body: 'We can match 5,800. Contract attached.' } });
check('below-floor price is BLOCKED, not held', floor.decision === 'BLOCK' && (floor.rules || []).includes('R08'), `${floor.decision} ${JSON.stringify(floor.rules)} executed=${floor.executed}`);
check('a blocked action reports nothing executed', floor.executed === false, `executed=${floor.executed}`);
check('the worker is told what to do instead', /do not retry/i.test(floor.what_now || ''), floor.what_now);

const spend = await call('request_action', { action: 'send_email', args: { to: 'orders@quickprint.example', body: 'Please go ahead with the 6 units, SGD 720.' } });
check('unconfirmed spend is HELD for the owner', spend.decision === 'HOLD_FOR_APPROVAL' && (spend.rules || []).includes('R12'), `${spend.decision} ${JSON.stringify(spend.rules)}`);

const brif = await call('this_morning');
check('the run produces an owner briefing', /stopped|waiting/i.test(brif.headline || '') && !/undefined|null/.test(JSON.stringify(brif).slice(0, 4000)), brif.headline);

srv.stdin.end(); srv.kill('SIGTERM');

const w = Math.max(...results.map((r) => r.label.length));
console.log(`\n ╔══ Kagi gate · live MCP protocol probe (${results.length} assertions)\n ╠══`);
for (const r of results) console.log(` ${r.pass ? '✔' : '✘'} ${r.label.padEnd(w)}  ${r.pass ? '' : 'FAIL → '}${(r.detail || '').slice(0, 96)}`);
const failed = results.filter((r) => !r.pass);
console.log(` ╚══ ${results.length - failed.length}/${results.length} passed${failed.length ? '  ← ' + failed.map((f) => f.label).join('; ') : ''}\n`);
process.exit(failed.length ? 1 : 0);
