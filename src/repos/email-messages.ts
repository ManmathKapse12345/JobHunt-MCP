import { writePool, type Db } from "../db/pool.js";
import {
  type ClassifiedEmail,
  classifyEmail,
  type EmailCategory,
  type OpportunityKind,
} from "../google/classify.js";
import type { Extraction } from "../google/extract.js";
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
  category: EmailCategory | null; // null until classified
  kind: OpportunityKind | null;
  organization: string | null;
  // From the email text, by the extractor (008). extracted_at null = not read yet.
  role: string | null;
  extracted_kind: OpportunityKind | null;
  event_at: Date | null;
  deadline_at: Date | null;
  extracted_at: Date | null;
  extracted_by: string | null;
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

// Rerun the rules over every stored email of the account. Returns how many rows changed.
export async function classifyStoredEmails(connectionId: string, db: Db = writePool): Promise<number> {
  const { rows } = await db.query<{ id: string; from_header: string; subject: string }>(
    "select id, from_header, subject from email_messages where connection_id = $1",
    [connectionId],
  );
  if (rows.length === 0) return 0;
  const c = rows.map((r) => classifyEmail({ from: r.from_header, subject: r.subject }));
  const { rowCount } = await db.query(
    `update email_messages e
        set category = v.category, kind = v.kind, organization = v.organization
       from unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) as v (id, category, kind, organization)
      where e.id = v.id
        and (e.category, e.kind, e.organization) is distinct from (v.category, v.kind, v.organization)`,
    [rows.map((r) => r.id), c.map((x) => x.category), c.map((x) => x.kind), c.map((x) => x.organization)],
  );
  return rowCount ?? 0;
}

export async function listClassifiedEmails(connectionId: string, db: Db = writePool): Promise<ClassifiedEmail[]> {
  const { rows } = await db.query<EmailMessageRow>(
    "select * from email_messages where connection_id = $1 and category is not null order by received_at",
    [connectionId],
  );
  return rows.map((r) => ({
    id: r.gmail_id,
    threadId: r.thread_id,
    from: r.from_header,
    subject: r.subject,
    receivedAt: r.received_at,
    category: r.category!,
    kind: r.kind,
    organization: r.organization,
    extracted: r.extracted_at
      ? { role: r.role, kind: r.extracted_kind, eventAt: r.event_at, deadlineAt: r.deadline_at }
      : undefined,
  }));
}

export async function saveExtraction(
  connectionId: string,
  gmailId: string,
  x: Extraction,
  model: string,
  db: Db = writePool,
): Promise<void> {
  await db.query(
    `update email_messages
        set role = $3, extracted_kind = $4, event_at = $5, deadline_at = $6, extracted_at = now(), extracted_by = $7
      where connection_id = $1 and gmail_id = $2`,
    [connectionId, gmailId, x.role, x.kind, x.eventAt, x.deadlineAt, model],
  );
}

export async function markSynced(connectionId: string, db: Db = writePool): Promise<void> {
  await db.query("update gmail_connections set last_synced_at = now() where id = $1", [connectionId]);
}
