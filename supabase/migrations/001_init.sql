-- 001_init.sql: initial schema for the job-application tracker.
--
-- Tables
--   companies        one row per employer
--   applications     one row per (company, role) you are tracking; soft-deleted via deleted_at
--   contacts         people at a company (recruiters, referrers, interviewers)
--   events           status-change history, written automatically by a trigger
--   pending_actions  writes proposed by an AI agent, waiting for human approval
--
-- Run it in the Supabase SQL editor, or with `supabase db push` once the CLI is linked.

-- ---------- enums ----------

create type application_status as enum (
  'wishlist',
  'applied',
  'oa',
  'interview',
  'offer',
  'rejected'
);

create type pending_action_status as enum (
  'pending',
  'approved',
  'rejected',
  'expired'
);

-- ---------- shared trigger: keep updated_at current ----------

create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- companies ----------

create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  website     text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- "Stripe" and "stripe" are the same company.
create unique index companies_name_key on companies (lower(name));

create trigger companies_updated_at
  before update on companies
  for each row execute function set_updated_at();

-- ---------- applications ----------

create table applications (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete restrict,
  role        text not null check (length(trim(role)) > 0),
  status      application_status not null default 'wishlist',
  applied_at  date,
  url         text,
  source      text,           -- where you found it: LinkedIn, referral, careers page...
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz     -- null = live; set = soft-deleted
);

-- One live application per company + role; a soft-deleted one does not block re-applying.
create unique index applications_company_role_key
  on applications (company_id, lower(role))
  where deleted_at is null;

create index applications_company_id_idx on applications (company_id);
create index applications_status_idx     on applications (status)     where deleted_at is null;
create index applications_applied_at_idx on applications (applied_at) where deleted_at is null;

create trigger applications_updated_at
  before update on applications
  for each row execute function set_updated_at();

-- ---------- contacts ----------

create table contacts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies (id) on delete set null,
  name          text not null check (length(trim(name)) > 0),
  title         text,
  email         text,
  linkedin_url  text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index contacts_company_id_idx on contacts (company_id);

create trigger contacts_updated_at
  before update on contacts
  for each row execute function set_updated_at();

-- ---------- events (status-change history) ----------

create table events (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references applications (id) on delete cascade,
  from_status     application_status,   -- null for the first event (row created)
  to_status       application_status not null,
  occurred_at     timestamptz not null default now(),
  note            text
);

create index events_application_id_idx on events (application_id, occurred_at);

-- Every insert, and every update that changes status, records an event,
-- so the history cannot drift from the applications table.
create function log_status_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into events (application_id, from_status, to_status)
    values (new.id, null, new.status);
  elsif new.status is distinct from old.status then
    insert into events (application_id, from_status, to_status)
    values (new.id, old.status, new.status);
  end if;
  return new;
end;
$$;

create trigger applications_log_status
  after insert or update of status on applications
  for each row execute function log_status_change();

-- ---------- pending_actions (human-in-the-loop approval) ----------

create table pending_actions (
  id          uuid primary key default gen_random_uuid(),
  tool_name   text not null,          -- e.g. 'add_application'
  payload     jsonb not null,         -- the arguments the agent wants to apply
  summary     text not null,          -- one line shown to the human when approving
  status      pending_action_status not null default 'pending',
  result      jsonb,                  -- what applying it produced, once approved
  error       text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  -- decided_at is set exactly when the action leaves 'pending'.
  check ((status = 'pending') = (decided_at is null))
);

-- The approval queue is read as "oldest pending first".
create index pending_actions_pending_idx
  on pending_actions (created_at)
  where status = 'pending';

-- ---------- row level security ----------
-- Supabase exposes the public schema over its REST API. With RLS on and no policies,
-- the anon key can read nothing; the MCP server connects with the service role or a
-- direct Postgres connection, both of which bypass RLS.

alter table companies       enable row level security;
alter table applications    enable row level security;
alter table contacts        enable row level security;
alter table events          enable row level security;
alter table pending_actions enable row level security;
