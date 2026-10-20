import { writePool, type Db } from "../db/pool.js";
import type { GmailMessage } from "../google/gmail-source.js";

// Only the write pool: mcp_reader has no access to this table.
// Stores metadata only. GmailMessage.text (the body) is deliberately never written.

export interface EmailMessageRow {
  id: string;
  connection_id: string;
  gmail_id: string;
  thread_id: string;
  from_header: string;
  subject: string;
  received_at: Date;
  fetched_at: Date;
}

// Which of these Gmail ids are already stored for the account.
export async function knownGmailIds(connectionId: string, gmailIds: string[], db: Db = writePool): Promise<Set<string>> {
  if (gmailIds.length === 0) return new Set();
  const { rows } = await db.query<{ gmail_id: string }>(
    "select gmail_id from email_messages where connection_id = $1 and gmail_id = any($2)",
    [connectionId, gmailIds],
  );
  return new Set(rows.map((r) => r.gmail_id));
}

// True if the message was new. A message that is already there (say, a sync running at the
// same time stored it first) is left as it is.
export async function insertEmailMessage(connectionId: string, m: GmailMessage, db: Db = writePool): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into email_messages (connection_id, gmail_id, thread_id, from_header, subject, received_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (connection_id, gmail_id) do nothing`,
    [connectionId, m.id, m.threadId, m.from, m.subject, m.receivedAt],
  );
  return rowCount === 1;
}

export async function markSynced(connectionId: string, db: Db = writePool): Promise<void> {
  await db.query("update gmail_connections set last_synced_at = now() where id = $1", [connectionId]);
}
