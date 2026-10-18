-- 003_mcp_reader.sql: a least-privilege login role for the MCP server's read tools.
--
-- The read tools (and resources, prompts) run whenever the model decides to call them.
-- Connecting them as mcp_reader means a bug or injection in a read path can only ever
-- read three tables: it cannot write, and cannot see pending_actions (approval tokens).
-- Write tools keep using DATABASE_URL (the postgres role), behind human approval.
--
-- This file sets NO password, so none ends up in git. After running it, set one yourself
-- in the Supabase SQL editor:
--     alter role mcp_reader with password '<a long random password>';
-- then put it in .env as DATABASE_URL_READER (see .env.example).
--
-- Safe to run more than once.

-- ---------- the role ----------

do $$
begin
  if not exists (select from pg_roles where rolname = 'mcp_reader') then
    -- noinherit: it never picks up privileges from roles it might later be granted.
    create role mcp_reader with login noinherit connection limit 10;
  end if;
end;
$$;

-- Defence in depth: even if a write privilege were granted by mistake, every
-- transaction this role starts is read-only, and no query can run away.
alter role mcp_reader set default_transaction_read_only = on;
alter role mcp_reader set statement_timeout = '5s';

-- ---------- privileges: start from nothing, add only what the read tools use ----------

revoke all on all tables    in schema public from mcp_reader;
revoke all on all sequences in schema public from mcp_reader;
revoke all on all functions in schema public from mcp_reader;

grant usage on schema public to mcp_reader;
grant select on companies, applications, events to mcp_reader;
-- Not granted: contacts (no tool reads it yet), pending_actions (holds token hashes).
-- Tables created later get no grants either: new access is always a deliberate GRANT.

-- ---------- row level security ----------
-- 001 enabled RLS on every table without policies. The postgres role has BYPASSRLS, so
-- that never mattered; mcp_reader does not, so without these policies every SELECT
-- would quietly return 0 rows. Policies are per role and per command: these allow
-- SELECT for mcp_reader only.

drop policy if exists mcp_reader_select on companies;
create policy mcp_reader_select on companies
  for select to mcp_reader using (true);

-- Soft-deleted applications are invisible to the reader at the database level,
-- so even a query that forgets "deleted_at is null" cannot return one.
drop policy if exists mcp_reader_select on applications;
create policy mcp_reader_select on applications
  for select to mcp_reader using (deleted_at is null);

drop policy if exists mcp_reader_select on events;
create policy mcp_reader_select on events
  for select to mcp_reader using (true);
