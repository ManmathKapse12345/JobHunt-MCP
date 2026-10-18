import { pool } from "../db/pool.js";
import type { ApplicationStatus } from "./applications.js";

export interface EventRow {
  from_status: ApplicationStatus | null;
  to_status: ApplicationStatus;
  occurred_at: Date;
  note: string | null;
}

// Status history of one application, oldest first.
export async function listEvents(applicationId: string): Promise<EventRow[]> {
  const { rows } = await pool.query<EventRow>(
    `select from_status, to_status, occurred_at, note
       from events
      where application_id = $1
      order by occurred_at, from_status nulls first`,
    [applicationId],
  );
  return rows;
}