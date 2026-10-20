-- 007_email_classification.sql: what each synced email says happened.
--
-- Filled in by the rules in src/google/classify.ts, from sender and subject only. Every
-- sync reruns them over all stored emails, so changing a rule needs no backfill.
-- Which emails get TRACKED is decided from these columns at read time: only opportunities
-- with a confirmation ("Thank you for applying", "Your application was sent to ...").
--
-- Safe to run more than once.

alter table email_messages
  add column if not exists category text
    check (category in ('applied', 'interview', 'assessment', 'rejected', 'offer', 'update', 'not_job')),
  add column if not exists kind text check (kind in ('job', 'internship', 'competition')),
  -- As the email names it, e.g. "Acme Robotics" or "Yuva Yodha Energy Tech Hackathon 2026".
  add column if not exists organization text;

create index if not exists email_messages_category_idx on email_messages (connection_id, category);
