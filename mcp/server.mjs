#!/usr/bin/env node
// mcp/server.mjs — the gate as an MCP server, so a live QwenWork agent can only act through it.
//
// This is what makes the veto physical rather than promotional. A worker session
// pointed at this server has no email tool, no upload tool and no file writer. It
// has `request_action`. The gateway holds the credentials and performs the action
// only after the policy verdict, and every attempt - allowed, held or blocked -
// lands in the append-only ledger.
//
// Zero dependencies: MCP is JSON-RPC 2.0 over stdio, newline delimited.

import { createInterface } from 'node:readline';
import { openDb, append, ledger, verifyChain } from '../src/log.mjs';
import { ingest } from '../src/classify.mjs';
import { extractAll, mineObligations } from '../src/facts.mjs';
import { loadPolicy, buildRoster, EXTERNAL_TOOLS } from '../src/policy.mjs';
import { submit } from '../src/gate.mjs';
import { checkProvenance } from '../src/provenance.mjs';
import { decide } from '../src/approvals.mjs';
import { loadDataFiles, readData, ROOT_DIR } from '../src/fsio.mjs';

const db = await openDb();
const files = await ingest(db, async () => loadDataFiles());
await extractAll(db);
await mineObligations(db);
const policy = await loadPolicy(db, ROOT_DIR);
const roster = await buildRoster(db, ROOT_DIR);

let runId = process.env.MCP_RUN_ID || ('mcp_' + new Date().toISOString().slice(11, 16).replace(':', '') + '_live');
let task = { goal: 'unassigned', scope: { files: [], clients: [], keywords: [] } };

const TOOLS = [
  {
    name: 'open_task',
    description: 'Register the job the owner gave you, including which files she named as in scope. Regulated data is only readable if it is named here by her.',
    inputSchema: { type: 'object', properties: { goal: { type: 'string' }, in_scope_files: { type: 'array', items: { type: 'string' } }, clients: { type: 'array', items: { type: 'string' } }, keywords: { type: 'array', items: { type: 'string' } } }, required: ['goal'] },
  },
  {
    name: 'read_file',
    description: 'Open a file. Logged, classified and gated: reading regulated data that the owner did not name for this job is refused.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'request_action',
    description: 'Ask to do something with consequences: send_email, upload_to_external_tool, delete_file, order_from_supplier, pay_supplier, quote_price, accept_terms. This is the ONLY way anything leaves the building. You get ALLOW (done), HOLD_FOR_APPROVAL (the owner decides) or BLOCK (not done, with the rule and the evidence).',
    inputSchema: { type: 'object', properties: { action: { type: 'string' }, args: { type: 'object' }, why: { type: 'string' } }, required: ['action', 'args'] },
  },
  {
    name: 'check_draft',
    description: 'Pre-flight a message to a client before you request sending it: every figure, date and quantity is compared with the documents that govern that client.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['body'] },
  },
  {
    name: 'my_pending',
    description: 'List actions waiting on the owner right now.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'this_morning',
    description: 'The briefing the owner reads. Ask for it at the end of a run.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, a = {}) {
  if (name === 'open_task') {
    task = { goal: a.goal, scope: { files: a.in_scope_files ?? [], clients: a.clients ?? [], keywords: a.keywords ?? [] } };
    await append(db, { run_id: runId, actor: 'mei.tan', actor_kind: 'human', kind: 'intent', action: 'assign_task', reason: a.goal, payload: { scope: task.scope, scope_basis: 'owner-declared', channel: 'mcp' } });
    return { ok: true, task, note: task.scope.files.length ? `named in scope: ${task.scope.files.join(', ')}` : 'nothing was named, so no regulated file is readable for this job' };
  }
  if (name === 'read_file') {
    const hay = files.find((f) => f.path === a.path);
    const r = await submit(db, { policy, roster, task, action: 'read_file', args: { path: a.path }, actor: a.actor ?? 'worker.qwenwork', runId });
    return r.decision === 'ALLOW'
      ? { ok: true, decision: r.decision, rules: r.rule_ids, content: readData(a.path), classification: r.level }
      : { ok: false, decision: r.decision, rules: r.rule_ids, reason: r.rules.map((x) => x.why).join('; ') };
  }
  if (name === 'request_action') {
    const r = await submit(db, { policy, roster, task, action: a.action, args: a.args ?? {}, actor: a.actor ?? 'worker.qwenwork', runId });
    return {
      decision: r.decision, rules: r.rule_ids, level: r.level,
      explanation_for_owner: (r.findings ?? []).map((f) => f.text),
      rule_reasons: r.rules.map((x) => `${x.id} (${x.decision}): ${x.why}`),
      executed: !!r.executed, followups: r.followups ?? [],
      ...(r.decision === 'ALLOW' ? {} : { what_now: r.decision === 'BLOCK' ? 'do not retry this action; tell the owner and offer the compliant alternative' : 'the draft is in the owner queue, one answer per item' }),
    };
  }
  if (name === 'check_draft') {
    const client = roster.partyFor(a.to ?? '')?.name ?? null;
    const checks = await checkProvenance(db, a.body, { client });
    return { client, checks: checks.map((c) => ({ claim: c.raw, status: c.status, against: (c.contradictedBy ?? c.cites ?? []).slice(0, 2).map((m) => `${m.path}${m.locator ? '@' + m.locator : ''}${m.field ? ' {' + m.field + '}' : ''}: ${m.context ?? m.value ?? ''}`) })) };
  }
  if (name === 'my_pending') {
    const rows = await ledger(db, { runId });
    const answered = new Set(rows.filter((r) => r.kind === 'approval').map((r) => Number(r.approval_for)));
    return { pending: rows.filter((r) => r.decision === 'HOLD_FOR_APPROVAL' && !answered.has(r.seq)).map((r) => ({ seq: r.seq, action: r.action, why: r.reason, rules: r.rules })) };
  }
  if (name === 'this_morning') {
    const { buildBriefing } = await import('../src/briefing.mjs');
    return await buildBriefing(db, runId);
  }
  if (name === 'owner_decide') {   // host-side only: the owner, never the worker
    return await decide(db, { runId, seq: a.seq, verdict: a.verdict, note: a.note, args: a.args ?? null });
  }
  return { error: `unknown tool ${name}` };
}

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lumen-oversight-gate', version: '1.0.0' } } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/call') {
    try {
      const out = await callTool(params.name, params.arguments ?? {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out?.ok === false || !!out?.error } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'gate error: ' + e.message }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method ${method} not supported` } });
});
process.stderr.write(`lumen oversight gate · mcp stdio · run ${runId} · policy v${policy.version} · ${Object.keys(EXTERNAL_TOOLS).length} known external tools\n`);
