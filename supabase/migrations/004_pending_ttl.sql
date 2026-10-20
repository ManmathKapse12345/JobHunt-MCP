-- 004_pending_ttl.sql: approval links expire after 15 minutes instead of 24 hours.
--
-- The server sets expires_at itself (PENDING_TTL_MINUTES in src/repos/pending-actions.ts);
-- this keeps the column default in line with it.
--
-- Safe to run more than once.

alter table pending_actions
  alter column expires_at set default now() + interval '15 minutes';

-- Links already handed out under the old 24-hour rule get the new limit too.
update pending_actions
   set expires_at = least(expires_at, created_at + interval '15 minutes')
 where status = 'pending';
