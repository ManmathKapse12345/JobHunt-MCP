-- 008_email_extraction.sql: what Claude read out of a tracked email's text.
--
-- Only emails of confirmed opportunities are read (src/google/extract.ts), once each.
-- The text itself is still never stored: just these few facts.
-- Kept apart from the rules' columns (category, kind, organization) on purpose: the model
-- never decides what is tracked.
--
-- Safe to run more than once.

alter table email_messages
  add column if not exists role text,
  add column if not exists extracted_kind text check (extracted_kind in ('job', 'internship', 'competition')),
  add column if not exists event_at timestamptz,     -- interview / assessment start
  add column if not exists deadline_at timestamptz,  -- must be done by
  add column if not exists extracted_at timestamptz, -- null = not read yet
  add column if not exists extracted_by text;        -- model id, e.g. claude-haiku-5-5
