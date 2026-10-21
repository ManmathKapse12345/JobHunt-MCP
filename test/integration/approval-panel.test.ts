// The in-chat approval panel (MCP App), driven the way Claude Desktop drives it: the write
// tool's result carries the pending change, the panel shows it, and the human's click comes
// back as a decide_approval call. Same rules as the approval link: nothing changes before
// the click, only the ticked changes apply, and a decision counts once.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_APP_URI } from "../../src/tools/approval-app.js";
import { appRow, count, eventsOf, resetDb, seedApplication, snapshotDb } from "../helpers/db.js";
import { connectClient, textOf } from "../helpers/mcp.js";

type Panel = { id: string; token: string; kind: string; title: string; items: Array<{ summary: string }>; expiresAt: string };
type Decision = { kind: string; message?: string; status?: string; items?: Array<{ outcome: string }> };

let mcp: Awaited<ReturnType<typeof connectClient>>;
let ids: string[];

beforeEach(async () => {
  await resetDb();
  ids = [await seedApplication({ company: "Stripe", role: "SDE" }), await seedApplication({ company: "Notion", role: "SRE" })];
});
afterEach(() => mcp?.close());

const panelOf = (r: unknown) => (r as { structuredContent?: { approval?: Panel } }).structuredContent?.approval;
const decisionOf = (r: unknown) => (r as { structuredContent: { decision: Decision } }).structuredContent.decision;
// What the panel sends when the human clicks.
const click = (p: Panel, decision: "approve" | "reject", items?: number[]) =>
  mcp.call("decide_approval", { id: p.id, token: p.token, decision, ...(items ? { items } : {}) });

describe("a client that shows MCP Apps (Claude Desktop)", () => {
  beforeEach(async () => {
    mcp = await connectClient({ elicitation: false, apps: true });
  });

  it("write tools point to the panel; the panel tool is for the app only", async () => {
    const { tools } = await mcp.client.listTools();
    const meta = (name: string) => tools.find((t) => t.name === name)?._meta as { ui?: { resourceUri?: string; visibility?: string[] } };
    for (const name of ["add_application", "update_application_status", "update_application", "delete_application", "propose_changes", "propose_email_updates"]) {
      expect(meta(name).ui?.resourceUri).toBe(APPROVAL_APP_URI);
    }
    expect(meta("decide_approval").ui).toEqual({ resourceUri: APPROVAL_APP_URI, visibility: ["app"] });
  });

  it("serves the panel as an MCP App resource: self-contained, no outside requests", async () => {
    const r = await mcp.client.readResource({ uri: APPROVAL_APP_URI });
    const c = r.contents[0] as { mimeType: string; text: string };
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c.text).toContain('request("ui/initialize"');
    expect(c.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=|fetch\(|innerHTML/);
  });

  it("a batch: the result carries the list, nothing changes until the click, only ticked ones apply", async () => {
    const before = await snapshotDb();
    const r = await mcp.call("propose_changes", {
      changes: [
        { action: "status", id: ids[0], status: "interview" },
        { action: "status", id: ids[1], status: "rejected" },
      ],
    });
    expect(textOf(r)).toMatch(/approval panel/);
    const p = panelOf(r)!;
    expect(p).toMatchObject({ kind: "batch", title: "2 changes to your tracker:" });
    expect(p.items.map((i) => i.summary)).toEqual([
      'Change the status of "SDE" at Stripe: applied -> interview.',
      'Change the status of "SRE" at Notion: applied -> rejected.',
    ]);
    expect({ ...(await snapshotDb()), pending_actions: [] }).toEqual({ ...before, pending_actions: [] });

    const d = decisionOf(await click(p, "approve", [1]));
    expect(d).toMatchObject({ kind: "approved", message: "Applied 1 of 2 changes; 1 not ticked." });
    expect(d.items!.map((i) => i.outcome)).toEqual(["skipped", "applied"]);
    expect((await appRow(ids[0]!)).status).toBe("applied");
    expect((await appRow(ids[1]!)).status).toBe("rejected");
    expect((await eventsOf(ids[1]!)).at(-1)).toMatchObject({ kind: "status_change", actor: "user via approval panel (vitest)" });

    // A decision counts once.
    expect(decisionOf(await click(p, "approve", [0]))).toEqual({ kind: "already", status: "approved" });
    expect((await appRow(ids[0]!)).status).toBe("applied");
  });

  it("a single change: approve applies it", async () => {
    const p = panelOf(await mcp.call("update_application_status", { id: ids[0], status: "offer" }))!;
    expect(p).toMatchObject({ kind: "single", title: "Approve this change?", items: [{ summary: 'Change the status of "SDE" at Stripe: applied -> offer.' }] });
    expect(decisionOf(await click(p, "approve"))).toMatchObject({ kind: "approved" });
    expect((await appRow(ids[0]!)).status).toBe("offer");
  });

  it("reject, or nothing ticked: nothing changes", async () => {
    for (const [decision, items] of [["reject", undefined], ["approve", []]] as const) {
      const p = panelOf(await mcp.call("propose_changes", { changes: [{ action: "add", company: "Hooli", role: "QA" }, { action: "add", company: "Initech", role: "QA" }] }))!;
      expect(decisionOf(await click(p, decision, items ? [...items] : undefined))).toEqual({ kind: "rejected" });
    }
    expect(await count("applications")).toBe(2);
  });

  it("a wrong token decides nothing", async () => {
    const p = panelOf(await mcp.call("update_application_status", { id: ids[0], status: "offer" }))!;
    const r = await click({ ...p, token: "x".repeat(43) }, "approve");
    expect(r.isError).toBe(true);
    expect(decisionOf(r)).toEqual({ kind: "invalid" });
    expect((await appRow(ids[0]!)).status).toBe("applied");
    expect(await count("pending_actions", "status = 'pending'")).toBe(1);
  });

  it("changed meanwhile: approved, not applied, and said so", async () => {
    const p = panelOf(await mcp.call("update_application_status", { id: ids[0], status: "offer" }))!;
    // Meanwhile the application is deleted (another approved change).
    await click(panelOf(await mcp.call("delete_application", { id: ids[0] }))!, "approve");
    expect(decisionOf(await click(p, "approve"))).toMatchObject({ kind: "not-applied" });
  });
});

describe("a client without MCP Apps", () => {
  it("gets the link as before, no panel data, and no panel tool", async () => {
    mcp = await connectClient({ elicitation: false });
    const r = await mcp.call("update_application_status", { id: ids[0], status: "offer" });
    expect(textOf(r)).toMatch(/Give the user this link/);
    expect(panelOf(r)).toBeUndefined();
    expect((await mcp.client.listTools()).tools.map((t) => t.name)).not.toContain("decide_approval");
  });
});
