import type pg from "pg";
import { readPool } from "../db/pool.js";
import type { ApplicationStatus } from "./applications.js";

export type EventKind = "created" | "status_change" | "updated" | "deleted";

export interface EventRow {
  kind: EventKind;
  from_status: ApplicationStatus | null;
  to_status: ApplicationStatus;
  occurred_at: Date;
  actor: string | null;
  note: string | null;
  details: Record<string, unknown> | null;
}

// History of one application, oldest first.
export async function listEvents(applicationId: string): Promise<EventRow[]> {
  const { rows } = await readPool.query<EventRow>(
    `select kind, from_status, to_status, occurred_at, actor, note, details
       from events
      where application_id = $1
      order by occurred_at, from_status nulls first`,
    [applicationId],
  );
  return rows;
}

// Audit row for changes the status trigger does not see (edits, deletes).
// to_status is the application's current, unchanged status.
export async function insertAuditEvent(
  client: pg.PoolClient,
  e: {
    applicationId: string;
    kind: "updated" | "deleted";
    actor: string;
    note?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `insert into events (application_id, kind, from_status, to_status, actor, note, details)
     select id, $2, status, status, $3, $4, $5 from applications where id = $1`,
    [e.applicationId, e.kind, e.actor, e.note ?? null, e.details ?? null],
  );
}
