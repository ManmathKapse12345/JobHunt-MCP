import { writePool } from "../../src/db/pool.js";
import type { ApplicationStatus } from "../../src/repos/applications.js";
import { assertLocalDatabase } from "../env.js";

// Empty every table. Called before each integration test, so each one starts from a
// known state no matter what ran before it.
export async function resetDb() {
  assertLocalDatabase();
  await writePool.query(
    "truncate companies, applications, contacts, events, pending_actions, gmail_connections, email_messages restart identity cascade",
  );
}

export interface SeedApplication {
  company: string;
  role: string;
  status?: ApplicationStatus;
  appliedAt?: string | null;
  source?: string | null;
  notes?: string | null;
  // Pretend the last status change happened this many days ago (for find_stale_applications).
  quietDays?: number;
  deleted?: boolean;
}

// Insert one application the way the database would end up after real use: the trigger
// writes its "created" event, which we then backdate if asked.
export async function seedApplication(a: SeedApplication): Promise<string> {
  await writePool.query("insert into companies (name) values ($1) on conflict (lower(name)) do nothing", [a.company]);
  const status = a.status ?? "applied";
  const { rows } = await writePool.query<{ id: string }>(
    `insert into applications (company_id, role, status, applied_at, source, notes)
     select id, $2, $3, $4, $5, $6 from companies where lower(name) = lower($1)
     returning id`,
    [
      a.company,
      a.role,
      status,
      a.appliedAt === undefined ? (status === "wishlist" ? null : "2026-10-01") : a.appliedAt,
      a.source ?? null,
      a.notes ?? null,
    ],
  );
  const id = rows[0]!.id;
  if (a.quietDays !== undefined) {
    await writePool.query("update events set occurred_at = now() - make_interval(days => $2) where application_id = $1", [
      id,
      a.quietDays,
    ]);
  }
  if (a.deleted) await writePool.query("update applications set deleted_at = now() where id = $1", [id]);
  return id;
}

// Every row of every table the write path can touch, in a stable order. Two equal
// snapshots mean nothing changed: not a row, not a value, not even updated_at.
export async function snapshotDb() {
  const tables = ["companies", "applications", "events", "pending_actions"] as const;
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = (await writePool.query(`select * from ${t} order by id`)).rows;
  return out;
}

export async function appRow(id: string) {
  const { rows } = await writePool.query("select * from applications where id = $1", [id]);
  return rows[0];
}

export async function eventsOf(id: string) {
  const { rows } = await writePool.query(
    "select kind, from_status, to_status, actor, note, details from events where application_id = $1 order by occurred_at, kind",
    [id],
  );
  return rows;
}

export async function count(table: string, where = "true", params: unknown[] = []) {
  const { rows } = await writePool.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, params);
  return rows[0]!.n;
}
