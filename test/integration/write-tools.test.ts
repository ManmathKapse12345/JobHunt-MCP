// Write tools when the human says YES (through elicitation): each changes exactly what it
// should and leaves an audit event saying who approved it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { todayIso } from "../../src/dates.js";
import { appRow, count, eventsOf, resetDb, seedApplication } from "../helpers/db.js";
import { ACCEPT, connectClient, textOf } from "../helpers/mcp.js";

let mcp: Awaited<ReturnType<typeof connectClient>>;
const ACTOR = "user via elicitation (vitest)";

beforeAll(async () => {
  mcp = await connectClient({ elicitation: true });
});
afterAll(async () => {
  await mcp.close();
});
beforeEach(async () => {
  await resetDb();
  mcp.human.answer = ACCEPT;
  mcp.human.asked = [];
});

const idIn = (text: string) => /id ([0-9a-f-]{36})/.exec(text)?.[1] ?? "";

describe("add_application", () => {
  it("asks once, then saves the application and a 'created' event", async () => {
    const r = await mcp.call("add_application", { company: "Stripe", role: "SDE", source: "LinkedIn" });
    expect(textOf(r)).toMatch(/^The user approved\. Added "SDE" at Stripe \(status applied, id /);
    expect(mcp.human.asked).toEqual([expect.stringContaining('Add a new application: "SDE" at Stripe, status applied')]);

    const id = idIn(textOf(r));
    expect(await appRow(id)).toMatchObject({ role: "SDE", status: "applied", applied_at: todayIso(), source: "LinkedIn" });
    expect(await eventsOf(id)).toEqual([expect.objectContaining({ kind: "created", to_status: "applied", actor: ACTOR })]);
  });

  it("reuses an existing company (case-insensitive) and leaves wishlist entries undated", async () => {
    await seedApplication({ company: "Stripe", role: "Backend" });
    const r = await mcp.call("add_application", { company: "stripe", role: "Frontend", status: "wishlist" });
    expect(await count("companies")).toBe(1);
    expect((await appRow(idIn(textOf(r)))).applied_at).toBeNull();
  });

  it("refuses a duplicate before asking the human", async () => {
    await seedApplication({ company: "Stripe", role: "SDE" });
    const r = await mcp.call("add_application", { company: " STRIPE ", role: "sde" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Already tracking "SDE" at Stripe/);
    expect(mcp.human.asked).toEqual([]);
  });
});

describe("update_application_status", () => {
  it("changes the status and logs from/to, actor and note", async () => {
    const id = await seedApplication({ company: "Stripe", role: "SDE" });
    const r = await mcp.call("update_application_status", { id, status: "interview", note: "phone screen" });
    expect(textOf(r)).toBe('The user approved. "SDE" at Stripe is now "interview".');
    expect((await appRow(id)).status).toBe("interview");
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      kind: "status_change",
      from_status: "applied",
      to_status: "interview",
      note: "phone screen",
      actor: ACTOR,
    });
  });

  it("fills applied_at the first time an application leaves the wishlist", async () => {
    const id = await seedApplication({ company: "Stripe", role: "SDE", status: "wishlist" });
    await mcp.call("update_application_status", { id, status: "applied" });
    expect((await appRow(id)).applied_at).toBe(todayIso());
  });

  it("refuses a no-op without asking", async () => {
    const id = await seedApplication({ company: "Stripe", role: "SDE" });
    const r = await mcp.call("update_application_status", { id, status: "applied" });
    expect(textOf(r)).toMatch(/already "applied"\. Nothing to change/);
    expect(mcp.human.asked).toEqual([]);
  });
});

describe("update_application", () => {
  it("edits only the given fields and audits before/after", async () => {
    const id = await seedApplication({ company: "Stripe", role: "SDE", notes: null });
    const r = await mcp.call("update_application", { id, notes: "recruiter: Asha", url: "https://stripe.com/jobs/1" });
    expect(textOf(r)).toMatch(/^The user approved\. Updated (url, notes|notes, url)\.$/);
    expect(await appRow(id)).toMatchObject({ notes: "recruiter: Asha", url: "https://stripe.com/jobs/1", role: "SDE" });
    expect((await eventsOf(id)).at(-1)).toMatchObject({
      kind: "updated",
      actor: ACTOR,
      details: {
        before: { notes: null, url: null },
        after: { notes: "recruiter: Asha", url: "https://stripe.com/jobs/1" },
      },
    });
  });

  it("refuses when nothing would change", async () => {
    const id = await seedApplication({ company: "Stripe", role: "SDE", notes: "same" });
    expect(textOf(await mcp.call("update_application", { id, notes: "same" }))).toMatch(/Nothing to change/);
    expect(mcp.human.asked).toEqual([]);
  });
});

describe("delete_application", () => {
  it("soft-deletes: the row and history stay, every read skips it", async () => {
    const id = await seedApplication({ company: "Stripe", role: "SDE" });
    const r = await mcp.call("delete_application", { id, reason: "closed the role" });
    expect(textOf(r)).toBe('The user approved. Deleted "SDE" at Stripe.');
    expect((await appRow(id)).deleted_at).not.toBeNull();
    expect((await eventsOf(id)).at(-1)).toMatchObject({ kind: "deleted", note: "closed the role", actor: ACTOR });
    expect((await mcp.call("get_application", { id })).isError).toBe(true);
  });

  it("errors for an unknown id without asking", async () => {
    const r = await mcp.call("delete_application", { id: "00000000-0000-4000-8000-000000000000" });
    expect(r.isError).toBe(true);
    expect(mcp.human.asked).toEqual([]);
  });
});
