import { z } from "zod";
import { isoDate } from "./dates.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// The project folder: one level up from this file (dist/ or src/).
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export const DATA_PATH =
  process.env.JOBHUNT_DATA_PATH ||
  path.join(projectRoot, "data", "applications.json");

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

const ApplicationsFileSchema = z.array(ApplicationSchema);

export type Application = z.infer<typeof ApplicationSchema>;
// Everything the caller provides. The store fills in id/createdAt/updatedAt.
export type NewApplication = Omit<
  Application,
  "id" | "createdAt" | "updatedAt"
>;

export async function loadApplications(): Promise<Application[]> {
  let raw: string;
  try {
    raw = await readFile(DATA_PATH, "utf8");
  } catch (err) {
    // No file yet = nobody has added an application yet. That's normal, not an error.
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err; // Any other problem (no permission, etc.) must NOT be hidden.
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${DATA_PATH} is not valid JSON. Fix or delete the file.`);
  }

  const result = ApplicationsFileSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `${DATA_PATH} has invalid data:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}


export async function saveApplications(apps: Application[]): Promise<void> {
  // Never write data that loadApplications() would later reject.
  ApplicationsFileSchema.parse(apps);

  // data/ doesn't exist on first run. `recursive: true` also means "no error if it already exists".
  await mkdir(path.dirname(DATA_PATH), { recursive: true });

  // Temp file sits NEXT TO the real file (same folder, same disk), so rename can be atomic.
  // process.pid makes the name unique per server process (Claude Desktop and Claude Code each run one).
  const tmpPath = `${DATA_PATH}.${process.pid}.tmp`;

  await writeFile(tmpPath, JSON.stringify(apps, null, 2) + "\n", "utf8");
  await rename(tmpPath, DATA_PATH);
}

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

// NOTE: this lock only works inside ONE process. Claude Desktop and Claude Code
// each run their own server; simultaneous writes from both can still lose an update.
// Planned fix: move this store to SQLite (node:sqlite).
let writeQueue: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task);
  writeQueue = run.catch(() => {}); // a failed task must not block the ones after it
  return run;
}

const normalize = (s: string) => s.trim().toLowerCase();

export function addApplication(input: NewApplication): Promise<Application> {
  return withWriteLock(async () => {
    const apps = await loadApplications();

    const existing = apps.find(
      (a) =>
        normalize(a.company) === normalize(input.company) &&
        normalize(a.role) === normalize(input.role),
    );
    if (existing) {
      throw new DuplicateApplicationError(existing);
    }

    const now = new Date().toISOString();
    const app = ApplicationSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    });

    await saveApplications([...apps, app]);
    return app;
  });
}
