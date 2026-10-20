import { writePool, type Db } from "../db/pool.js";

// Only the write pool: mcp_reader has no access to this table at all.

export interface GmailConnectionRow {
  id: string;
  email: string;
  refresh_token_enc: string;
  scopes: string;
  connected_at: Date;
  updated_at: Date;
  last_synced_at: Date | null;
}

// Reconnecting the same account replaces its token (and keeps its sync position).
export async function upsertGmailConnection(
  c: { email: string; refreshTokenEnc: string; scopes: string },
  db: Db = writePool,
): Promise<GmailConnectionRow> {
  const { rows } = await db.query<GmailConnectionRow>(
    `insert into gmail_connections (email, refresh_token_enc, scopes)
     values ($1, $2, $3)
     on conflict (lower(email)) do update
       set refresh_token_enc = excluded.refresh_token_enc, scopes = excluded.scopes, updated_at = now()
     returning *`,
    [c.email, c.refreshTokenEnc, c.scopes],
  );
  return rows[0]!;
}

// One connected account for now (a personal tracker). The newest wins if there are several.
export async function getGmailConnection(db: Db = writePool): Promise<GmailConnectionRow | undefined> {
  const { rows } = await db.query<GmailConnectionRow>("select * from gmail_connections order by updated_at desc limit 1");
  return rows[0];
}

export async function deleteGmailConnection(id: string, db: Db = writePool): Promise<void> {
  await db.query("delete from gmail_connections where id = $1", [id]);
}
