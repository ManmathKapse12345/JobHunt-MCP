import { pool } from "../db/pool.js";

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

// Shared SELECT list, so every query returns the same ApplicationRow shape.
const COLUMNS = `
  a.id, c.name as company, a.role, a.status, a.applied_at, a.source, a.url, a.notes`;

export async function listApplications(filters: {
  status?: ApplicationStatus;
  company?: string;
  limit: number;
}): Promise<ApplicationRow[]> {
  // "$1::type is null or ..." makes each filter optional while keeping one fixed query.
  const { rows } = await pool.query<ApplicationRow>(
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

export async function getApplicationById(id: string): Promise<ApplicationRow | undefined> {
  const { rows } = await pool.query<ApplicationRow>(
    `select ${COLUMNS}
       from applications a
       join companies c on c.id = a.company_id
      where a.deleted_at is null and a.id = $1`,
    [id],
  );
  return rows[0];
}

export async function findApplications(company: string, role?: string): Promise<ApplicationRow[]> {
  const { rows } = await pool.query<ApplicationRow>(
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
  const { rows } = await pool.query<StaleApplicationRow>(
    `select ${COLUMNS},
            last.occurred_at as last_change,
            (current_date - last.occurred_at::date) as days_quiet
       from applications a
       join companies c on c.id = a.company_id
       join lateral (
              select max(e.occurred_at) as occurred_at
                from events e
               where e.application_id = a.id
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
    pool.query<{ status: ApplicationStatus; count: number }>(
      `select status, count(*)::int as count
         from applications where deleted_at is null
        group by status order by status`,
    ),
    pool.query<{ source: string; count: number }>(
      `select coalesce(source, 'unknown') as source, count(*)::int as count
         from applications where deleted_at is null
        group by 1 order by 2 desc`,
    ),
    pool.query<{ total: number; sent: number; responded: number }>(
      `select count(*)::int as total,
              count(*) filter (where status <> 'wishlist')::int as sent,
              count(*) filter (where status in ('oa', 'interview', 'offer', 'rejected'))::int as responded
         from applications where deleted_at is null`,
    ),
  ]);
  const t = totals.rows[0] ?? { total: 0, sent: 0, responded: 0 };
  return { byStatus: byStatus.rows, bySource: bySource.rows, ...t };
}