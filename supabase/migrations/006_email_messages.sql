-- 006_email_messages.sql: job-related emails the Gmail sync has already seen.
--
-- Metadata only: sender, subject and date. Email BODIES ARE NEVER STORED; the sync reads
-- them into memory for classification (later) and keeps nothing else.
--
-- The unique (connection_id, gmail_id) is what makes the sync idempotent: syncing the
-- same inbox twice stores each message once.
--
-- Safe to run more than once.

create table if not exists email_messages (
  id             uuid primary key default gen_random_uuid(),
  -- Disconnecting Gmail deletes the account's row, and with it everything read from it.
  connection_id  uuid not null references gmail_connections (id) on delete cascade,
  gmail_id       text not null,              -- Gmail's message id (unique per mailbox)
  thread_id      text not null,
  from_header    text not null,              -- e.g. "LinkedIn <jobs-noreply@linkedin.com>"
  subject        text not null,
  received_at    timestamptz not null,       -- when Gmail received it (internalDate)
  fetched_at     timestamptz not null default now(),
  unique (connection_id, gmail_id)
);

create index if not exists email_messages_received_idx on email_messages (connection_id, received_at desc);

-- Same as every other table: nothing over Supabase's REST API.
alter table email_messages enable row level security;

-- mcp_reader gets no grant (003: new tables get none). Read tools see sync results through
-- the sync report, not this table.
