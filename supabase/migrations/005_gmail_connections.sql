-- 005_gmail_connections.sql: a connected Gmail account, for reading job-related email.
--
-- The server only ever asks Google for read-only access (gmail.readonly). What it keeps is
-- the long-lived refresh token, ENCRYPTED by the server (AES-256-GCM, key in the
-- TOKEN_ENCRYPTION_KEY environment variable): this table alone is not enough to read
-- anyone's mail. Short-lived access tokens are never stored.
--
-- Safe to run more than once.

create table if not exists gmail_connections (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  -- "v1.<iv>.<ciphertext+tag>", see src/crypto/secret-box.ts
  refresh_token_enc  text not null,
  scopes             text not null,          -- what Google actually granted, space-separated
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_synced_at     timestamptz             -- set by the sync (later)
);

-- One row per Google account; reconnecting the same account replaces its token.
create unique index if not exists gmail_connections_email_key on gmail_connections (lower(email));

-- Same as every other table: nothing over Supabase's REST API.
alter table gmail_connections enable row level security;

-- mcp_reader gets no grant at all (003: new tables get none): read tools can never see a token.
