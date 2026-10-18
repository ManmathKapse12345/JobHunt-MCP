import type pg from "pg";
import { pool } from "./pool.js";

// Run fn inside BEGIN ... COMMIT on one connection. Any throw rolls everything back,
// so a change and its audit event are saved together or not at all.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {}); // the original error matters more
    throw err;
  } finally {
    client.release();
  }
}

// Who approved this change, and an optional note. The events trigger reads both.
// is_local = true: the settings vanish at COMMIT/ROLLBACK and never reach another request.
export async function setAuditContext(client: pg.PoolClient, actor: string, note?: string) {
  await client.query(
    "select set_config('jobhunt.actor', $1, true), set_config('jobhunt.note', $2, true)",
    [actor, note ?? ""],
  );
}
