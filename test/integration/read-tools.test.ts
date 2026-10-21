import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { todayIso } from "../../src/dates.js";
import { resetDb, seedApplication } from "../helpers/db.js";
import { connectClient, textOf } from "../helpers/mcp.js";

let mcp: Awaited<ReturnType<typeof connectClient>>;
let ids: Record<"stripeBackend" | "stripeData" | "infosys" | "google" | "zomatoDeleted", string>;

beforeAll(async () => {
  mcp = await connectClient({ elicitation: false });
});
afterAll(async () => {
  await mcp.close();
});

// A small, known tracker. Open = applied/oa/interview; "quiet" = days since last status change.
beforeEach(async () => {
  await resetDb();
  ids = {
    stripeBackend: await seedApplication({ company: "Stripe", role: "Backend Engineer", source: "LinkedIn", quietDays: 20 }),
    stripeData: await seedApplication({
      company: "Stripe",
      role: "Data Engineer",
      status: "interview",
      source: "Referral",
      notes: "recruiter: Asha",
      quietDays: 3,
    }),
    infosys: await seedApplication({ company: "Infosys", role: "SDE", status: "rejected", source: "Indeed", quietDays: 30 }),
    google: await seedApplication({ company: "Google", role: "SWE", status: "wishlist", quietDays: 40 }),
    zomatoDeleted: await seedApplication({ company: "Zomato", role: "Backend", source: "Indeed", quietDays: 50, deleted: true }),
  };
});

describe("tool list", () => {
  it("has all 12 tools, with the read ones marked read-only", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_application",
      "days_since",
      "delete_application",
      "find_stale_applications",
      "get_application",
      "get_pipeline_summary",
      "list_applications",
      "ping",
      "propose_email_updates",
      "sync_job_emails",
      "update_application",
      "update_application_status",
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(["find_stale_applications", "get_application", "get_pipeline_summary", "list_applications"]);
  });
});

describe("list_applications", () => {
  it("lists live applications only (never soft-deleted ones)", async () => {
    const t = textOf(await mcp.call("list_applications"));
    expect(t).toMatch(/^4 application\(s\):/);
    expect(t).not.toContain("Zomato");
  });

  it("filters by status, by part of the company name, and limits", async () => {
    expect(textOf(await mcp.call("list_applications", { status: "interview" }))).toMatch(/^1 application\(s\):\n- Data Engineer at Stripe/);
    expect(textOf(await mcp.call("list_applications", { company: "stri" }))).toMatch(/^2 application\(s\)/);
    expect(textOf(await mcp.call("list_applications", { limit: 1 }))).toMatch(/^1 application\(s\)/);
    expect(textOf(await mcp.call("list_applications", { company: "nobody" }))).toBe("No applications match those filters.");
  });

  it("rejects a status that does not exist", async () => {
    const r = mcp.call("list_applications", { status: "interviewing" });
    await expect(r.then(textOf)).resolves.toMatch(/Invalid option/);
  });
});

describe("get_application", () => {
  it("by id: shows the application, notes and history", async () => {
    const t = textOf(await mcp.call("get_application", { id: ids.stripeData }));
    expect(t).toContain("- Data Engineer at Stripe | interview");
    expect(t).toContain("Notes: recruiter: Asha");
    expect(t).toMatch(/History:\n- \d{4}-\d{2}-\d{2}: created as interview/);
  });

  it("by company: asks which one when several match, returns it when one does", async () => {
    expect(textOf(await mcp.call("get_application", { company: "Stripe" }))).toMatch(/^2 applications match; ask the user/);
    expect(textOf(await mcp.call("get_application", { company: "Stripe", role: "data" }))).toContain("Data Engineer at Stripe");
  });

  it("errors for unknown, deleted, or missing input", async () => {
    const unknown = await mcp.call("get_application", { id: "00000000-0000-4000-8000-000000000000" });
    expect(unknown.isError).toBe(true);
    expect((await mcp.call("get_application", { id: ids.zomatoDeleted })).isError).toBe(true);
    expect(textOf(await mcp.call("get_application", {}))).toBe("Give either an id or a company name.");
  });
});

describe("find_stale_applications", () => {
  it("returns open applications quiet for at least N days, oldest first", async () => {
    // Infosys (rejected), Google (wishlist) and Zomato (deleted) are quiet too, but not open.
    const t14 = textOf(await mcp.call("find_stale_applications", { days: 14 }));
    expect(t14).toMatch(/^1 application\(s\) quiet for 14\+ days:\n- Backend Engineer at Stripe \| applied \| no change for 20 days/);

    const t2 = textOf(await mcp.call("find_stale_applications", { days: 2 }));
    expect(t2).toMatch(/^2 application\(s\)/);
    expect(t2.indexOf("Backend Engineer")).toBeLessThan(t2.indexOf("Data Engineer"));
  });

  it("says so when nothing is stale", async () => {
    expect(textOf(await mcp.call("find_stale_applications", { days: 60 }))).toMatch(/^Nothing stale/);
  });

  it("counts only status changes as progress, not edits", async () => {
    // A fresh 'updated' event (e.g. notes edited today) must not reset the quiet counter.
    const { writePool } = await import("../../src/db/pool.js");
    await writePool.query(
      "insert into events (application_id, kind, from_status, to_status) values ($1, 'updated', 'applied', 'applied')",
      [ids.stripeBackend],
    );
    expect(textOf(await mcp.call("find_stale_applications", { days: 14 }))).toContain("Backend Engineer at Stripe");
  });
});

describe("get_pipeline_summary", () => {
  it("counts live applications by status and source, with the response rate", async () => {
    const t = textOf(await mcp.call("get_pipeline_summary"));
    // 4 live; sent = everything but wishlist (3); responded = interview + rejected (2).
    expect(t).toContain("Total tracked: 4 (3 sent, 1 on the wishlist)");
    expect(t).toContain("Response rate: 2/3 = 67%");
    expect(t).toContain("- applied: 1");
    expect(t).toContain("- unknown: 1"); // Google has no source
    expect(t).not.toContain("- Indeed: 2"); // the deleted Zomato row is not counted
  });
});

describe("utility tools", () => {
  it("ping and days_since", async () => {
    expect(textOf(await mcp.call("ping", { message: "hi" }))).toBe("pong: hi");
    expect(textOf(await mcp.call("days_since", { date: todayIso() }))).toBe(`0 days since ${todayIso()}`);
    expect((await mcp.call("days_since", { date: "2999-01-01" })).isError).toBe(true);
  });
});
