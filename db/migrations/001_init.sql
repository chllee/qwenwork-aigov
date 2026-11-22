-- 001_init.sql — Lumen oversight layer
-- Design rule: the ledger is ONE append-only table with ONE writer.
-- Every component (human intent, worker intent, verdict, finding, approval, result)
-- is an event. Nothing else is allowed to be a source of truth.

create table if not exists policy_versions (
  version        text primary key,
  loaded_at      timestamptz not null default now(),
  source_sha256  text not null,
  rule_count     int  not null,
  raw            jsonb not null
);

create table if not exists files (
  path           text primary key,
  bytes          int  not null,
  sha256         text not null,
  declared_level text,                 -- from the file's own `sensitivity:` header
  derived_level  text,                 -- from content-only classification
  derived_rank   int,
  score_card     jsonb,                -- which signals fired
  classified_at  timestamptz
);

-- Extracted, locatable values. This is what makes a number checkable.
create table if not exists facts (
  id         bigserial primary key,
  path       text not null references files(path),
  locator    text not null,            -- 'L12' or 'line: Subtotal'
  field      text,                     -- subtotal | surcharge | total | floor | fee | units | date | ...
  raw        text not null,            -- exact matched text
  value      numeric,                  -- null for non-numeric facts (dates, names)
  unit       text,                     -- SGD | pct | days | count
  context    text                      -- short surrounding text, for citations
);
create index if not exists facts_path_idx on facts(path);
create index if not exists facts_value_idx on facts(value);

-- Obligations the oversight layer mined out of prose (weekly plan, contracts).
-- A rule that nobody wrote down is still a rule.
create table if not exists obligations (
  id            text primary key,
  client        text,                  -- NULL = owner-wide
  kind          text not null,         -- price_floor | written_confirmation_required | no_retaining_tool | action_required | confidentiality_scope
  params        jsonb not null,
  source_path   text not null,
  source_quote  text not null,
  status        text not null default 'mined',   -- mined | ratified | rejected
  linked_rule   text,                  -- policy rule it strengthens (R08, R12, ...)
  created_at    timestamptz not null default now()
);

-- THE LEDGER. Insert-only. No updates, no deletes, hash-chained.
create table if not exists events (
  seq            bigserial primary key,
  id             text not null unique,
  ts             text not null,
  run_id         text,
  actor          text not null,        -- 'mei.tan' | 'worker.marketing' | 'oversight'
  actor_kind     text not null,        -- human | worker | oversight | system
  kind           text not null,        -- intent | action | verdict | finding | approval | result | note
  action         text,                 -- read_file | send_email | delete_file | upload_to_external_tool | ...
  data_level     text,
  policy_version text,
  rules          jsonb,                -- ["R15"]
  evidence       jsonb,                -- [{path,locator,quote}]
  decision       text,                 -- ALLOW | HOLD_FOR_APPROVAL | BLOCK
  reason         text,
  payload        jsonb,
  approval_for   bigint,               -- seq of the held event, if this is an approval
  hash           text not null,
  prev_hash      text not null
);
create index if not exists events_run_idx on events(run_id);
create index if not exists events_kind_idx on events(kind);
create index if not exists events_decision_idx on events(decision);

create or replace function events_is_append_only() returns trigger as $$
begin
  raise exception 'events is append-only: % is not permitted (ledger integrity)', TG_OP;
end $$ language plpgsql;

drop trigger if exists events_no_edit on events;
create trigger events_no_edit
  before update or delete on events
  for each row execute function events_is_append_only();

-- Convenience views for the ledger UI
create or replace view v_violations as
  select * from events where kind = 'finding' order by seq;

create or replace view v_pending as
  select e.* from events e
  where e.decision = 'HOLD_FOR_APPROVAL'
    and not exists (select 1 from events a where a.approval_for = e.seq);

-- Label integrity: the declared header must agree with the content.
create or replace view v_label_conflicts as
  select path, declared_level, derived_level from files
  where declared_level is distinct from derived_level;
