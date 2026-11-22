# Kagi workstation

The **world** the agents act on, without a gate in it. This is the base layer for the
Agents-Watching-Agents track: a one-person studio's workspace where actions have real,
inspectable consequences, so that "the gate stopped it" can be proven later by looking at
a directory rather than reading a log line I wrote about myself.

Run it (Node 20+, zero dependencies, no install):

```
npm start          # http://localhost:3000   ·  world/ created on first run
npm test           # 30 assertions, checked against the filesystem
```

## What is real here

AvePoint's scenario pack only ever names five verbs, so those are the tool surface:
`read_file`, `list_dir`, `send_email`, `upload_to_external_tool`, `delete_file`.
Everything else — the world, the journal, refusals — is the substrate the gate will sit on.

| Verb | Effect on disk |
|---|---|
`read_file docs/…` | content returned, and an append-only **read receipt** per actor in `world/docs/.reads/<actor>.log` (with a content hash, so an edited file is visible) |
`list_dir <area>` | names and sizes only — **never contents**, which is why a `client-confidential` hit is a lead, not a leak |
`send_email to,…` | a draft in `drafts/<party>/`; `deliver:true` **also** writes to `outbox/<party>/` |
`upload_to_external_tool target,file` | the bytes genuinely copied to `egress/<tool>/`, plus `*.receipt.json` (tool, origin, sha256, who, why) |
`delete_file path,reason` | the file is **gone from `docs/`**; only a wrapper JSON survives in `trash/` — origin, actor, reason, sha, previous content |

Nothing else is needed for the demo, and nothing else is assumed:
uploads arrive by **streaming** into `docs/` (a large file never becomes one huge string),
and `/api/stage?src=…` reads **only** from roots declared at launch via `KAGI_CORPUS`,
refusing anything else, because that endpoint can otherwise read any file this process can.

## The journal

`world/journal.jsonl` is append-only and hash-chained: `seq`, server-stamped `actor`, and a
running chain (row `hash = sha256(prev + canonical)`). Every action writes an `intent`
**before** it can touch the world; an `effect` row records the outcome. Verify with
`GET /api/verify`, or run `/api/verify` after editing a line by hand to see it break.

## Not here yet, on purpose

**No gate.** Every action today runs unchecked; `GET /api/info` says `mode: passthrough`
and every journal row carries that — the app cannot misreport its own governance state.
The seam is the flagged comment in `src/dispatch.mjs`: that is the only insertion point
for `ALLOW / HOLD_FOR_APPROVAL / BLOCK`. `npm run gate` starts in `gated` mode, and will
loudly say the gate is absent until one exists.

**No LLM.** Nothing here calls a model: the worker, the decision-maker and the world are
honest code, and AvePoint's five verbs were written by hand into the UI as a form. A model
gets wired in once the gate exists — otherwise you would only be demonstrating that
prompts can be scripted.

Also deliberately missing: policy rules, sensitivity tiers, evidence and provenance checks,
approver queue. That is the *watcher*'s job, and the watcher comes on top of this layer.

## Layout

```
src/  world.mjs      the world: areas, safe paths, the five verbs
      journal.mjs    append-only hash-chained JSONL + verify
      dispatch.mjs   the seam: identity, intent-then-effect, KAGI GATE comment
      server.mjs     core-Node HTTP, streaming uploads
ui/   index.html     the console (vanilla JS, no build step)
test/ e2e.mjs        30 filesystem assertions; exits non-zero on any miss
```
