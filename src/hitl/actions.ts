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
import { pool } from "../db/pool.js";
import { setAuditContext } from "../db/tx.js";

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
  const app = await getApplicationById(id);
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
  const existing = await findLiveApplication(pool, input.company, input.role);
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

// ---------- registry ----------

const APPLY: Record<string, Apply> = {
  add_application: applyAdd,
  update_application_status: applyStatusChange,
  update_application: applyUpdate,
  delete_application: applyDelete,
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
