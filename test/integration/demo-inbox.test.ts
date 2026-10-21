// The demo inbox tells the story the demo script records: against the demo tracker it
// yields exactly these changes, so a take never surprises you.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoCalendar, demoExtractor, demoInbox } from "../../src/google/demo-inbox.js";
import { upsertGmailConnection } from "../../src/repos/gmail-connections.js";
import { resetDb, seedApplication } from "../helpers/db.js";
import { connectClient, textOf } from "../helpers/mcp.js";

let mcp: Awaited<ReturnType<typeof connectClient>>;

beforeEach(async () => {
  await resetDb();
  // The demo tracker's rows that the inbox touches (scripts/demo-seed.ts).
  await seedApplication({ company: "Google", role: "Software Engineer", status: "applied" });
  await seedApplication({ company: "Microsoft", role: "SDE 1", status: "oa" });
  await seedApplication({ company: "Razorpay", role: "Backend Engineer", status: "applied" });
  await seedApplication({ company: "Postman", role: "Developer Advocate", status: "applied" });
  await upsertGmailConnection({ email: "demo@example.com", refreshTokenEnc: "demo", scopes: "demo" });
  mcp = await connectClient({
    elicitation: false,
    apps: true,
    gmail: { source: demoInbox, extractor: () => demoExtractor, calendar: async () => demoCalendar },
  });
});
afterEach(() => mcp.close());

describe("demo inbox", () => {
  it("the report: one interview to move, one rejection, one new application, a deadline, Google ghosted", async () => {
    const t = textOf(await mcp.call("sync_job_emails", {}));
    expect(t).toMatch(/^Synced demo@example\.com: 10 new job emails/);
    expect(t).toMatch(/Razorpay .*\n {2}tracker: Backend Engineer at Razorpay, applied \(id [^)]+\); emails say interview\n {2}upcoming: interview on /);
    expect(t).toMatch(/Postman .*\n {2}tracker: Developer Advocate at Postman, applied \(id [^)]+\); emails say rejected/);
    expect(t).toMatch(/Microsoft .*\n {2}tracker: SDE 1 at Microsoft, oa \(id [^)]+\)\n {2}upcoming: due by /);
    expect(t).toMatch(/Linear .*\n {2}tracker: not tracked yet \(emails say applied\)/);
    expect(t).toMatch(/- Google: 3[45] days since the last email, ghosted/);
    expect(t).toContain("Ignored: 2 not about an application, 0 with no confirmation email.");
  });

  it("the proposal: three tracker changes and two calendar events, in one panel", async () => {
    await mcp.call("sync_job_emails", {});
    const r = (await mcp.call("propose_email_updates")) as { structuredContent?: { approval?: { items: Array<{ summary: string }> } } };
    const items = r.structuredContent!.approval!.items.map((i) => i.summary);
    expect(items).toHaveLength(5);
    // Status changes, most recently confirmed first (Postman, then Razorpay).
    expect(items[0]).toMatch(/"Developer Advocate" at Postman: applied -> rejected/);
    expect(items[1]).toMatch(/"Backend Engineer" at Razorpay: applied -> interview/);
    expect(items[2]).toMatch(/Add a new application: "Frontend Engineer" at Linear, status applied/);
    expect(items[3]).toMatch(/^Add to your calendar: "Interview: Razorpay \(Backend Engineer\)"/);
    expect(items[4]).toMatch(/^Add to your calendar: "Deadline: Microsoft \(SDE 1\)"/);
  });
});
