import type pg from "pg";
import { writePool, type Db } from "../db/pool.js";

export type PendingStatus = "pending" | "approved" | "rejected" | "expired";

export interface PendingActionRow {
  id: string;
  tool_name: string;
  payload: unknown;
  summary: string;
  status: PendingStatus;
  token_hash: string;
  result: unknown;
  error: string | null;
  created_at: Date;
  decided_at: Date | null;
  expires_at: Date;
}

// How long an approval link stays usable. Short: a change approved long after it was
// proposed may no longer be what the user wants, and a leaked link is useful only briefly.
// Set here rather than relying on the column default, so it holds even on a database that
// has not run 004_pending_ttl.sql yet.
export const PENDING_TTL_MINUTES = 15;

export async function insertPendingAction(a: {
  toolName: string;
  payload: unknown;
  summary: string;
  tokenHash: string;
}): Promise<{ id: string; expires_at: Date }> {
  const { rows } = await writePool.query<{ id: string; expires_at: Date }>(
    `insert into pending_actions (tool_name, payload, summary, token_hash, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(mins => $5))
     returning id, expires_at`,
    [a.toolName, JSON.stringify(a.payload), a.summary, a.tokenHash, PENDING_TTL_MINUTES],
  );
  return rows[0]!;
}

export async function getPendingAction(id: string, db: Db = writePool): Promise<PendingActionRow | undefined> {
  const { rows } = await db.query<PendingActionRow>("select * from pending_actions where id = $1", [id]);
  return rows[0];
}

// Marks old links as expired. (claimPendingAction already refuses an expired link on its
// own; this makes the status column say so too.) Returns how many were expired.
export async function expireOldPendingActions(): Promise<number> {
  const { rowCount } = await writePool.query(
    `update pending_actions set status = 'expired', decided_at = now()
      where status = 'pending' and expires_at <= now()`,
  );
  return rowCount ?? 0;
}

// Atomically moves ONE pending, unexpired action to `status`. Two clicks (or two
// server processes) racing on the same link: only one of them gets the row back.
export async function claimPendingAction(
  client: pg.PoolClient,
  id: string,
  status: "approved" | "rejected",
): Promise<PendingActionRow | undefined> {
  const { rows } = await client.query<PendingActionRow>(
    `update pending_actions set status = $2, decided_at = now()
      where id = $1 and status = 'pending' and expires_at > now()
      returning *`,
    [id, status],
  );
  return rows[0];
}

export async function recordOutcome(
  db: Db,
  id: string,
  outcome: { result?: unknown; error?: string },
): Promise<void> {
  await db.query("update pending_actions set result = $2, error = $3 where id = $1", [
    id,
    outcome.result === undefined ? null : JSON.stringify(outcome.result),
    outcome.error ?? null,
  ]);
}
