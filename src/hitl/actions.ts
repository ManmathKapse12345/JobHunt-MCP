import type pg from "pg";
import { z } from "zod";
import { isoDate, todayIso } from "../dates.js";
import {
  APPLICATION_STATUSES,
  changeStatus,
  EDITABLE_COLUMNS,
  findLiveApplication,
  getApplicationById,
  insertApplication,
  isUniqueViolation,
  softDeleteApplication,
  updateFields,
  type ApplicationRow,
  type EditableField,
} from "../repos/applications.js";
import { insertAuditEvent } from "../repos/events.js";
import { writePool } from "../db/pool.js";
import { setAuditContext } from "../db/tx.js";
import { type CalendarClient, type CalendarEvent, calendarFromEnv } from "../google/calendar.js";
import { OAuthError } from "../google/oauth.js";

// Every write goes through two steps:
//   prepare(input) -> { payload, summary }   checks the input against the database NOW and
//                                            builds the text the human approves
//   apply(payload)                           runs later, after approval, inside a transaction
// The payload is what gets stored in pending_actions, so it is validated again before apply.

// An expected "no" (not found, duplicate, changed meanwhile). Tools show it to the model;
// anything else is a bug and is thrown.
export class ActionError extends Error {}

export interface Prepared {
  toolName: string;
  payload: unknown;
  summary: string; // built from database rows, never from text the model wrote
}

type Apply = (client: pg.PoolClient, rawPayload: unknown, actor: string) => Promise<string>;

function defineAction<P>(
  payloadSchema: z.ZodType<P>,
  apply: (client: pg.PoolClient, payload: P, actor: string) => Promise<string>,
): Apply {
  return async (client, rawPayload, actor) => {
    const parsed = payloadSchema.safeParse(rawPayload);
    if (!parsed.success) throw new ActionError(`Stored change is invalid: ${z.prettifyError(parsed.error)}`);
    return apply(client, parsed.data, actor);
  };
}

const describe = (a: Pick<ApplicationRow, "role" | "company">) => `"${a.role}" at ${a.company}`;
const show = (v: string | null | undefined) => (v == null || v === "" ? "(empty)" : `"${v}"`);

async function loadLive(id: string): Promise<ApplicationRow> {
  const app = await getApplicationById(id, writePool);
  if (!app) throw new ActionError(`No application with id ${id} (it may have been deleted).`);
  return app;
}

// ---------- add_application ----------

const Status = z.enum(APPLICATION_STATUSES);

const AddPayload = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  status: Status,
  appliedAt: isoDate.nullable(),
  url: z.url().nullable(),
  source: z.string().nullable(),
  notes: z.string().nullable(),
});

export async function prepareAdd(input: {
  company: string;
  role: string;
  status: z.infer<typeof Status>;
  appliedOn?: string;
  url?: string;
  source?: string;
  notes?: string;
}): Promise<Prepared> {
  const existing = await findLiveApplication(writePool, input.company, input.role);
  if (existing) {
    throw new ActionError(`Already tracking ${describe(existing)} (id ${existing.id}). Nothing to add.`);
  }
  const payload: z.infer<typeof AddPayload> = {
    company: input.company,
    role: input.role,
    status: input.status,
    // Applying "today" is the common case; a wishlist entry has no applied date.
    appliedAt: input.appliedOn ?? (input.status === "wishlist" ? null : todayIso()),
    url: input.url ?? null,
    source: input.source ?? null,
    notes: input.notes ?? null,
  };
  const extras = [
    payload.appliedAt && `applied ${payload.appliedAt}`,
    payload.source && `via ${payload.source}`,
    payload.url && `URL ${payload.url}`,
    payload.notes && `notes ${show(payload.notes)}`,
  ].filter(Boolean);
  return {
    toolName: "add_application",
    payload,
    summary:
      `Add a new application: ${describe(payload)}, status ${payload.status}` +
      (extras.length ? ` (${extras.join(", ")})` : "") +
      ".",
  };
}

const applyAdd = defineAction(AddPayload, async (client, p, actor) => {
  await setAuditContext(client, actor);
  try {
    const id = await insertApplication(client, p);
    return `Added ${describe(p)} (status ${p.status}, id ${id}).`;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ActionError(`${describe(p)} is already tracked.`);
    throw err;
  }
});

// ---------- update_application_status ----------

const StatusPayload = z.object({
  id: z.uuid(),
  from: Status,
  to: Status,
  note: z.string().nullable(),
});

export async function prepareStatusChange(input: {
  id: string;
  status: z.infer<typeof Status>;
  note?: string;
}): Promise<Prepared> {
  const app = await loadLive(input.id);
  if (app.status === input.status) {
    throw new ActionError(`${describe(app)} is already "${app.status}". Nothing to change.`);
  }
  return {
    toolName: "update_application_status",
    payload: { id: app.id, from: app.status, to: input.status, note: input.note ?? null },
    summary:
      `Change the status of ${describe(app)}: ${app.status} -> ${input.status}` +
      (input.note ? ` (note: ${show(input.note)})` : "") +
      ".",
  };
}

const applyStatusChange = defineAction(StatusPayload, async (client, p, actor) => {
  await setAuditContext(client, actor, p.note ?? undefined);
  const changed = await changeStatus(client, p.id, p.from, p.to, todayIso());
  if (!changed) {
    throw new ActionError(
      `The application is no longer "${p.from}" (or was deleted) since approval was requested.`,
    );
  }
  const app = await getApplicationById(p.id, client);
  return `${app ? describe(app) : "Application"} is now "${p.to}".`;
});

// ---------- update_application ----------

const FieldValue = z.string().nullable();
const Changes = z
  .object({
    role: z.string().min(1).optional(),
    url: z.url().nullable().optional(),
    source: FieldValue.optional(),
    notes: FieldValue.optional(),
    appliedAt: isoDate.nullable().optional(),
  })
  .strict();

const UpdatePayload = z.object({
  id: z.uuid(),
  before: z.record(z.string(), z.string().nullable()),
  changes: Changes,
});

const CURRENT: Record<EditableField, (a: ApplicationRow) => string | null> = {
  role: (a) => a.role,
  url: (a) => a.url,
  source: (a) => a.source,
  notes: (a) => a.notes,
  appliedAt: (a) => a.applied_at,
};

export async function prepareUpdate(input: {
  id: string;
  role?: string;
  url?: string;
  source?: string;
  notes?: string;
  appliedOn?: string;
}): Promise<Prepared> {
  const app = await loadLive(input.id);
  const requested: Partial<Record<EditableField, string>> = {
    role: input.role,
    url: input.url,
    source: input.source,
    notes: input.notes,
    appliedAt: input.appliedOn,
  };
  const changes: Partial<Record<EditableField, string>> = {};
  const before: Partial<Record<EditableField, string | null>> = {};
  for (const field of Object.keys(EDITABLE_COLUMNS) as EditableField[]) {
    const next = requested[field];
    if (next !== undefined && next !== CURRENT[field](app)) {
      changes[field] = next;
      before[field] = CURRENT[field](app);
    }
  }
  const fields = Object.keys(changes) as EditableField[];
  if (fields.length === 0) throw new ActionError(`Nothing to change for ${describe(app)}.`);
  return {
    toolName: "update_application",
    payload: { id: app.id, before, changes },
    summary:
      `Edit ${describe(app)}:\n` +
      fields.map((f) => `- ${f}: ${show(before[f])} -> ${show(changes[f])}`).join("\n"),
  };
}

const applyUpdate = defineAction(UpdatePayload, async (client, p, actor) => {
  await setAuditContext(client, actor);
  let updated;
  try {
    updated = await updateFields(client, p.id, p.changes);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ActionError("Another application already has that company and role.");
    throw err;
  }
  if (!updated) throw new ActionError("The application was deleted since approval was requested.");
  await insertAuditEvent(client, {
    applicationId: p.id,
    kind: "updated",
    actor,
    details: { before: p.before, after: p.changes },
  });
  return `Updated ${Object.keys(p.changes).join(", ")}.`;
});

// ---------- delete_application ----------

const DeletePayload = z.object({ id: z.uuid(), reason: z.string().nullable() });

export async function prepareDelete(input: { id: string; reason?: string }): Promise<Prepared> {
  const app = await loadLive(input.id);
  return {
    toolName: "delete_application",
    payload: { id: app.id, reason: input.reason ?? null },
    summary:
      `Delete ${describe(app)} (status ${app.status}` +
      (app.applied_at ? `, applied ${app.applied_at}` : "") +
      ")" +
      (input.reason ? `, reason: ${show(input.reason)}` : "") +
      ". It disappears from every list, but the row and its history are kept (soft delete).",
  };
}

const applyDelete = defineAction(DeletePayload, async (client, p, actor) => {
  const app = await getApplicationById(p.id, client);
  const deleted = await softDeleteApplication(client, p.id);
  if (!deleted || !app) throw new ActionError("The application was already deleted.");
  await insertAuditEvent(client, {
    applicationId: p.id,
    kind: "deleted",
    actor,
    note: p.reason ?? undefined,
  });
  return `Deleted ${describe(app)}.`;
});

// ---------- add_calendar_event ----------
// Not a database change: the event goes to the user's Google Calendar. Its id comes from
// the email it was read from, so approving it twice adds it once.

const CalendarPayload = z.object({
  id: z.string().regex(/^[a-v0-9]{5,1024}$/),
  title: z.string().min(1).max(200),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  description: z.string().max(2000),
  remindMinutesBefore: z.array(z.number().int().min(0).max(40_320)).max(5),
});

let calendar: () => Promise<CalendarClient | undefined> = calendarFromEnv;
// Tests use a fake calendar.
export function useCalendar(provider: () => Promise<CalendarClient | undefined>) {
  calendar = provider;
}

const whenFmt = (d: Date) =>
  d.toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function prepareCalendarEvent(e: CalendarEvent): Prepared {
  const payload: z.infer<typeof CalendarPayload> = {
    id: e.id,
    title: e.title,
    start: e.start.toISOString(),
    end: e.end.toISOString(),
    description: e.description,
    remindMinutesBefore: e.remindMinutesBefore,
  };
  return {
    toolName: "add_calendar_event",
    payload,
    summary: `Add to your calendar: "${e.title}", ${whenFmt(e.start)} to ${e.end.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}.`,
  };
}

const applyCalendarEvent = defineAction(CalendarPayload, async (_client, p) => {
  const cal = await calendar();
  if (!cal) throw new ActionError("Calendar isn't connected (npm run calendar:connect), so the event was not added.");
  try {
    const r = await cal.insert({ ...p, start: new Date(p.start), end: new Date(p.end) });
    return r === "exists" ? `"${p.title}" is already on your calendar.` : `Added "${p.title}" to your calendar.`;
  } catch (err) {
    if (err instanceof OAuthError) throw new ActionError(err.message);
    throw err;
  }
});

// ---------- apply_batch: several changes, approved together ----------
// The human ticks which items to apply. Each runs behind its own savepoint, so one that
// no longer applies (changed meanwhile, now a duplicate) is undone alone and the rest stay.

const BATCHABLE = ["add_application", "update_application_status", "update_application", "add_calendar_event"] as const;
export const MAX_BATCH_ITEMS = 100;

const BatchPayload = z.object({
  items: z
    .array(z.object({ toolName: z.enum(BATCHABLE), payload: z.unknown(), summary: z.string() }))
    .min(1)
    .max(MAX_BATCH_ITEMS),
});
export type BatchItem = z.infer<typeof BatchPayload>["items"][number];

export function prepareBatch(title: string, items: Prepared[]): Prepared {
  if (items.length === 0) throw new ActionError("Nothing to change.");
  if (items.length > MAX_BATCH_ITEMS) throw new ActionError(`At most ${MAX_BATCH_ITEMS} changes in one batch.`);
  const batchItems = items.map((p) => {
    const toolName = z.enum(BATCHABLE).parse(p.toolName);
    return { toolName, payload: p.payload, summary: p.summary };
  });
  return {
    toolName: "apply_batch",
    payload: { items: batchItems },
    summary: `${title}\n${batchItems.map((it, i) => `${i + 1}. ${it.summary}`).join("\n")}`,
  };
}

export function batchItems(rawPayload: unknown): BatchItem[] {
  const parsed = BatchPayload.safeParse(rawPayload);
  if (!parsed.success) throw new ActionError(`Stored change is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data.items;
}

export interface BatchOutcome {
  summary: string;
  outcome: "applied" | "failed" | "skipped";
  message: string;
}

// selected: indexes of the items to apply; undefined = all of them.
export async function executeBatch(
  client: pg.PoolClient,
  rawPayload: unknown,
  actor: string,
  selected?: number[],
): Promise<{ message: string; items: BatchOutcome[] }> {
  const items = batchItems(rawPayload);
  const outcomes: BatchOutcome[] = [];
  for (const [i, item] of items.entries()) {
    if (selected && !selected.includes(i)) {
      outcomes.push({ summary: item.summary, outcome: "skipped", message: "Not ticked." });
      continue;
    }
    await client.query("savepoint batch_item");
    try {
      const message = await executeAction(client, item.toolName, item.payload, actor);
      await client.query("release savepoint batch_item");
      outcomes.push({ summary: item.summary, outcome: "applied", message });
    } catch (err) {
      // Also clears a failed statement (say a unique violation), which would otherwise
      // abort the whole transaction.
      await client.query("rollback to savepoint batch_item");
      if (!(err instanceof ActionError)) throw err;
      outcomes.push({ summary: item.summary, outcome: "failed", message: err.message });
    }
  }
  const n = (o: BatchOutcome["outcome"]) => outcomes.filter((x) => x.outcome === o).length;
  const message =
    `Applied ${n("applied")} of ${items.length} changes` +
    (n("failed") ? `; ${n("failed")} no longer applied and were left as they were` : "") +
    (n("skipped") ? `; ${n("skipped")} not ticked` : "") +
    ".";
  return { message, items: outcomes };
}

// ---------- registry ----------

const APPLY: Record<string, Apply> = {
  add_application: applyAdd,
  update_application_status: applyStatusChange,
  update_application: applyUpdate,
  delete_application: applyDelete,
  add_calendar_event: applyCalendarEvent,
  // Approved as a whole (an elicitation yes/no): every item.
  apply_batch: async (client, payload, actor) => (await executeBatch(client, payload, actor)).message,
};

// Runs an approved change inside the caller's transaction. Used both right after an
// elicitation "accept" and by the approval page.
export async function executeAction(
  client: pg.PoolClient,
  toolName: string,
  payload: unknown,
  actor: string,
): Promise<string> {
  const apply = APPLY[toolName];
  if (!apply) throw new ActionError(`Unknown action "${toolName}".`);
  return apply(client, payload, actor);
}
