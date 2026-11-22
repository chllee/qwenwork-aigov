-- 002_lines.sql — a text index of the corpus.
-- Numbers alone are not evidence: "Status: UNPAID" carries no digit, and it is the
-- single most important fact in the delete scenario. Non-numeric statements have to
-- be citable to a file and a line too.
create table if not exists lines (
  id      bigserial primary key,
  path    text not null references files(path),
  line_no int  not null,
  locator text not null,
  text    text not null
);
create index if not exists lines_path_idx on lines(path);
create index if not exists lines_text_idx on lines using gin (to_tsvector('simple', text));
