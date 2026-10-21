import type pg from "pg";
import { readPool, type Db } from "../db/pool.js";

// Must match the application_status enum in supabase/migrations/001_init.sql.
export const APPLICATION_STATUSES = [
  "wishlist",
  "applied",
  "oa",
  "interview",
  "offer",
  "rejected",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

// Statuses where you are still waiting on the company.
export const OPEN_STATUSES: ApplicationStatus[] = ["applied", "oa", "interview"];

export interface ApplicationRow {
  id: string;
  company: string;
  role: string;
  status: ApplicationStatus;
  applied_at: string | null; // YYYY-MM-DD
  source: string | null;
  url: string | null;
  notes: string | null;
}

export interface StaleApplicationRow extends ApplicationRow {
  last_change: Date;
  days_quiet: number;
}

// ---------- reads ----------
// These run on readPool (the SELECT-only mcp_reader role). The write path passes
// writePool or its transaction's client instead.

// Shared SELECT list, so every query returns the same ApplicationRow shape.
const COLUMNS = `
  a.id, c.name as company, a.role, a.status, a.applied_at, a.source, a.url, a.notes`;

export async function listApplications(filters: {
  status?: ApplicationStatus;
  company?: string;
  limit: number;
}): Promise<ApplicationRow[]> {
  // "$1::type is null or ..." makes each filter optional while keeping one fixed query.
  const { rows } = await readPool.query<ApplicationRow>(
    `select ${COLUMNS}
       from applications a
       join companies c on c.id = a.company_id
      where a.deleted_at is null
        and ($1::application_status is null or a.status = $1)
        and ($2::text is null or c.name ilike '%' || $2 || '%')
      order by a.applied_at desc nulls last, a.created_at desc
      limit $3`,
    [filters.status ?? null, filters.company ?? null, filters.limit],
  );
  return rows;
}

// Every live application, for matching email against the whole tracker.
export async function listAllApplications(db: Db = readPool): Promise<ApplicationRow[]> {
  const { rows } = await db.query<ApplicationRow>(
    `select ${COLUMNS}
       from applications a
       join companies c on c.id = a.company_id
      where a.deleted_at is null
      order by c.name, a.role`,
  );
  return rows;
}

export async function getApplicationById(
  id: string,
  db: Db = readPool,
): Promise<ApplicationRow | undefined> {
  const { rows } = await db.query<ApplicationRow>(
    `select ${COLUMNS}
       from applications a
       join companies c on c.id = a.company_id
      where a.deleted_at is null and a.id = $1`,
    [id],
  );
  return rows[0];
}

export async function findApplications(company: string, role?: string): Promise<ApplicationRow[]> {
  const { rows } = await readPool.query<ApplicationRow>(
    `select ${COLUMNS}
       from applications a
       join companies c on c.id = a.company_id
      where a.deleted_at is null
        and c.name ilike '%' || $1 || '%'
        and ($2::text is null or a.role ilike '%' || $2 || '%')
      order by a.applied_at desc nulls last
      limit 10`,
    [company, role ?? null],
  );
  return rows;
}

// Open applications whose status has not changed for at least `days` days.
// "Last change" is the newest row in events, which the database trigger keeps up to date.
export async function findStaleApplications(days: number): Promise<StaleApplicationRow[]> {
  const { rows } = await readPool.query<StaleApplicationRow>(
    `select ${COLUMNS},
            last.occurred_at as last_change,
            (current_date - last.occurred_at::date) as days_quiet
       from applications a
       join companies c on c.id = a.company_id
       join lateral (
              select max(e.occurred_at) as occurred_at
                from events e
               where e.application_id = a.id
                 and e.kind in ('created', 'status_change') -- editing notes is not progress
            ) last on true
      where a.deleted_at is null
        and a.status = any($1::application_status[])
        and last.occurred_at < now() - make_interval(days => $2::int)
      order by last.occurred_at`,
    [OPEN_STATUSES, days],
  );
  return rows;
}

export interface PipelineSummary {
  byStatus: { status: ApplicationStatus; count: number }[];
  bySource: { source: string; count: number }[];
  total: number;
  sent: number; // everything except wishlist
  responded: number; // got an answer: oa, interview, offer or rejected
}

export async function getPipelineSummary(): Promise<PipelineSummary> {
  // count(*) is a bigint, which pg returns as a string; ::int keeps it a number.
  const [byStatus, bySource, totals] = await Promise.all([
    readPool.query<{ status: ApplicationStatus; count: number }>(
      `select status, count(*)::int as count
         from applications where deleted_at is null
        group by status order by status`,
    ),
    readPool.query<{ source: string; count: number }>(
      `select coalesce(source, 'unknown') as source, count(*)::int as count
         from applications where deleted_at is null
        group by 1 order by 2 desc`,
    ),
    readPool.query<{ total: number; sent: number; responded: number }>(
      `select count(*)::int as total,
              count(*) filter (where status <> 'wishlist')::int as sent,
              count(*) filter (where status in ('oa', 'interview', 'offer', 'rejected'))::int as responded
         from applications where deleted_at is null`,
    ),
  ]);
  const t = totals.rows[0] ?? { total: 0, sent: 0, responded: 0 };
  return { byStatus: byStatus.rows, bySource: bySource.rows, ...t };
}
// ---------- writes ----------
// Each takes the transaction's client, so the change and its audit event commit together.

export async function findLiveApplication(
  db: Db,
  company: string,
  role: string,
): Promise<ApplicationRow | undefined> {
  const { rows } = await db.query<ApplicationRow>(
    `select ${COLUMNS}
       from applications a
       join companies c on c.id = a.company_id
      where a.deleted_at is null
        and lower(c.name) = lower($1)
        and lower(a.role) = lower($2)`,
    [company, role],
  );
  return rows[0];
}

export interface NewApplication {
  company: string;
  role: string;
  status: ApplicationStatus;
  appliedAt: string | null;
  url: string | null;
  source: string | null;
  notes: string | null;
}

// Creates the company if it is new, then the application. Returns the new id.
export async function insertApplication(client: pg.PoolClient, app: NewApplication): Promise<string> {
  await client.query(
    "insert into companies (name) values ($1) on conflict (lower(name)) do nothing",
    [app.company],
  );
  const { rows } = await client.query<{ id: string }>(
    `insert into applications (company_id, role, status, applied_at, url, source, notes)
     select id, $2, $3, $4, $5, $6, $7 from companies where lower(name) = lower($1)
     returning id`,
    [app.company, app.role, app.status, app.appliedAt, app.url, app.source, app.notes],
  );
  return rows[0]!.id;
}

// Moves status only if it is still `from` (someone may have changed it since the
// approval was requested). Fills applied_at the first time it leaves the wishlist.
// Returns false when nothing matched.
export async function changeStatus(
  client: pg.PoolClient,
  id: string,
  from: ApplicationStatus,
  to: ApplicationStatus,
  today: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update applications
        set status = $3::application_status,
            applied_at = case when applied_at is null and $3::application_status <> 'wishlist' then $4::date
                              else applied_at end
      where id = $1 and status = $2 and deleted_at is null`,
    [id, from, to, today],
  );
  return rowCount === 1;
}

// The only columns update_application may touch. Keys are what tools send,
// values are trusted column names, so user input never becomes SQL.
export const EDITABLE_COLUMNS = {
  role: "role",
  url: "url",
  source: "source",
  notes: "notes",
  appliedAt: "applied_at",
} as const;
export type EditableField = keyof typeof EDITABLE_COLUMNS;

export async function updateFields(
  client: pg.PoolClient,
  id: string,
  changes: Partial<Record<EditableField, string | null>>,
): Promise<boolean> {
  const fields = Object.keys(changes) as EditableField[];
  if (fields.length === 0) return false;
  const sets = fields.map((f, i) => `${EDITABLE_COLUMNS[f]} = $${i + 2}`);
  const { rowCount } = await client.query(
    `update applications set ${sets.join(", ")} where id = $1 and deleted_at is null`,
    [id, ...fields.map((f) => changes[f] ?? null)],
  );
  return rowCount === 1;
}

// Soft delete: the row stays (with its history) but every read query skips it.
export async function softDeleteApplication(client: pg.PoolClient, id: string): Promise<boolean> {
  const { rowCount } = await client.query(
    "update applications set deleted_at = now() where id = $1 and deleted_at is null",
    [id],
  );
  return rowCount === 1;
}

// Postgres error 23505: a unique index said no (same company + role already tracked).
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
