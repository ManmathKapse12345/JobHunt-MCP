import { z } from "zod";
import { isoDate } from "./dates.js";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// The project folder: one level up from this file (dist/ or src/).
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export const DATA_PATH =
  process.env.JOBHUNT_DATA_PATH || path.join(projectRoot, "data", "jobhunt.db");

// ---------- schema (unchanged) ----------
export const STATUSES = [
  "wishlist",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
] as const;
export const ApplicationSchema = z.object({
  id: z.uuid(),
  company: z.string().trim().min(1),
  role: z.string().trim().min(1),
  status: z.enum(STATUSES),
  appliedOn: isoDate.optional(),
  url: z.url().optional(),
  notes: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Application = z.infer<typeof ApplicationSchema>;
export type NewApplication = Omit<
  Application,
  "id" | "createdAt" | "updatedAt"
>;

export class DuplicateApplicationError extends Error {
  readonly existing: Application;
  constructor(existing: Application) {
    super(
      `Already tracking "${existing.role}" at ${existing.company} ` +
        `(id ${existing.id}, status: ${existing.status}).`,
    );
    this.name = "DuplicateApplicationError";
    this.existing = existing;
  }
}

// ---------- database setup (runs once, when the server starts) ----------
mkdirSync(path.dirname(DATA_PATH), { recursive: true });
const db = new DatabaseSync(DATA_PATH);

db.exec(`
  PRAGMA busy_timeout = 5000;   -- if another process is writing, wait up to 5s instead of failing
  PRAGMA journal_mode = WAL;    -- readers don't block the writer, and the writer doesn't block readers

  CREATE TABLE IF NOT EXISTS applications (
    id         TEXT PRIMARY KEY,
    company    TEXT NOT NULL,
    role       TEXT NOT NULL,
    status     TEXT NOT NULL,
    appliedOn  TEXT,
    url        TEXT,
    notes      TEXT,
    createdAt  TEXT NOT NULL,
    updatedAt  TEXT NOT NULL
  );

  -- The duplicate rule, enforced by the database itself (case- and space-insensitive).
  CREATE UNIQUE INDEX IF NOT EXISTS applications_company_role
    ON applications (lower(trim(company)), lower(trim(role)));
`);

const insertStmt = db.prepare(`
  INSERT INTO applications (id, company, role, status, appliedOn, url, notes, createdAt, updatedAt)
  VALUES (:id, :company, :role, :status, :appliedOn, :url, :notes, :createdAt, :updatedAt)
`);
const findByCompanyRoleStmt = db.prepare(`
  SELECT * FROM applications
  WHERE lower(trim(company)) = lower(trim(:company)) AND lower(trim(role)) = lower(trim(:role))
`);
const selectAllStmt = db.prepare(
  `SELECT * FROM applications ORDER BY createdAt`,
);

const SQLITE_CONSTRAINT_UNIQUE = 2067;

// SQL NULL comes back as null; the schema uses "missing" for optional fields.
function rowToApplication(row: Record<string, unknown>): Application {
  const present = Object.fromEntries(
    Object.entries(row).filter(([, v]) => v !== null),
  );
  return ApplicationSchema.parse(present);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    "errcode" in err &&
    err.errcode === SQLITE_CONSTRAINT_UNIQUE
  );
}

// ---------- public API (same signatures as before) ----------
export async function loadApplications(): Promise<Application[]> {
  return selectAllStmt.all().map(rowToApplication);
}

export async function addApplication(
  input: NewApplication,
): Promise<Application> {
  const now = new Date().toISOString();
  const app = ApplicationSchema.parse({
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });

  try {
    insertStmt.run({
      ...app,
      // node:sqlite can't store undefined, so empty optional fields become NULL.
      appliedOn: app.appliedOn ?? null,
      url: app.url ?? null,
      notes: app.notes ?? null,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = findByCompanyRoleStmt.get({
        company: app.company,
        role: app.role,
      });
      if (existing) {
        throw new DuplicateApplicationError(rowToApplication(existing));
      }
    }
    throw err;
  }
  return app;
}
