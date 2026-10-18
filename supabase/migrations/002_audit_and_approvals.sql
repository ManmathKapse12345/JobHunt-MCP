-- 002_audit_and_approvals.sql: audit trail for every write, and secret, expiring approval links.
--
-- events      becomes a full audit log: what kind of change, who approved it, before/after details.
-- pending_actions  stores only a hash of each approval link's token, plus an expiry time.

-- ---------- events: audit columns ----------

create type event_kind as enum ('created', 'status_change', 'updated', 'deleted');

alter table events
  add column kind    event_kind not null default 'status_change',
  add column actor   text,      -- who approved it, e.g. 'user via approval link'
  add column details jsonb;     -- e.g. {"before": {...}, "after": {...}} for edits

-- Rows written by 001's trigger: the first event of each application is its creation.
update events set kind = 'created' where from_status is null;

-- to_status keeps meaning "status after this event"; for 'updated' and 'deleted'
-- events it is simply the unchanged current status.

-- The status trigger now also records the kind, and reads the actor and note that
-- the application sets for the current transaction:
--   select set_config('jobhunt.actor', 'user via approval link', true);
-- (true = transaction-local, so it can never leak into another request.)
create or replace function log_status_change() returns trigger
language plpgsql as $$
declare
  v_actor text := nullif(current_setting('jobhunt.actor', true), '');
  v_note  text := nullif(current_setting('jobhunt.note', true), '');
begin
  if tg_op = 'INSERT' then
    insert into events (application_id, kind, from_status, to_status, actor, note)
    values (new.id, 'created', null, new.status, v_actor, v_note);
  elsif new.status is distinct from old.status then
    insert into events (application_id, kind, from_status, to_status, actor, note)
    values (new.id, 'status_change', old.status, new.status, v_actor, v_note);
  end if;
  return new;
end;
$$;

-- ---------- pending_actions: secret, expiring links ----------

alter table pending_actions
  -- SHA-256 of the token in the approval URL. The token itself is never stored,
  -- so reading this table is not enough to approve anything.
  add column token_hash text not null,
  add column expires_at timestamptz not null default now() + interval '24 hours';
