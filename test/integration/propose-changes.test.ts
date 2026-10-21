// Several changes asked for in chat: one approval with a checkbox per change, never one
// link per application.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setApprovalBaseUrl } from "../../src/hitl/links.js";
import { createApprovalHandler } from "../../src/hitl/approval-page.js";
import { appRow, count, resetDb, seedApplication, snapshotDb } from "../helpers/db.js";
import { connectClient, textOf } from "../helpers/mcp.js";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => void createApprovalHandler({ origins: [base] })(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setApprovalBaseUrl(base);
});
afterAll(() => new Promise((r) => server.close(r)));

let ids: string[];
beforeEach(async () => {
  await resetDb();
  ids = [
    await seedApplication({ company: "Stripe", role: "SDE" }),
    await seedApplication({ company: "Notion", role: "SRE" }),
    await seedApplication({ company: "Hooli", role: "QA", status: "rejected" }),
  ];
});

const linkIn = () => /http:\/\/127\.0\.0\.1:\d+\/approve\/\S+/g;

describe("propose_changes", () => {
  it("without in-chat approval: ONE link, a checkbox per change, nothing changed yet", async () => {
    const mcp = await connectClient({ elicitation: false });
    const before = await snapshotDb();
    const t = textOf(
      await mcp.call("propose_changes", {
        changes: [
          { action: "status", id: ids[0], status: "rejected", note: "no reply in 6 weeks" },
          { action: "status", id: ids[1], status: "rejected" },
          { action: "add", company: "Atlassian", role: "Frontend Engineer" },
        ],
      }),
    );
    await mcp.close();
    const links = t.match(linkIn()) ?? [];
    expect(links).toHaveLength(1);
    expect(await count("pending_actions")).toBe(1);
    expect({ ...(await snapshotDb()), pending_actions: [] }).toEqual({ ...before, pending_actions: [] });

    const page = await (await fetch(links[0]!)).text();
    expect(page).toContain("Approve 3 changes?");
    expect(page.match(/type="checkbox" name="item"/g)).toHaveLength(3);

    // Tick the first and the add only.
    const url = new URL(links[0]!);
    const body = await (
      await fetch(`${url.origin}${url.pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([["token", url.searchParams.get("token")!], ["item", "0"], ["item", "2"], ["decision", "approve"]]),
      })
    ).text();
    expect(body).toContain("Applied 2 of 3 changes; 1 not ticked.");
    expect((await appRow(ids[0]!)).status).toBe("rejected");
    expect((await appRow(ids[1]!)).status).toBe("applied");
    expect(await count("applications")).toBe(4);
  });

  it("with in-chat approval: one form, only the ticked changes apply", async () => {
    const mcp = await connectClient({ elicitation: true });
    mcp.human.answer = { action: "accept", content: { item_0: false, item_1: true } };
    const t = textOf(
      await mcp.call("propose_changes", {
        changes: [
          { action: "status", id: ids[0], status: "interview" },
          { action: "edit", id: ids[1], notes: "recruiter called" },
        ],
      }),
    );
    await mcp.close();
    expect(mcp.human.asked).toHaveLength(1);
    expect(t).toMatch(/^The user approved\. Applied 1 of 2 changes; 1 not ticked\./);
    expect((await appRow(ids[0]!)).status).toBe("applied");
    expect((await appRow(ids[1]!)).notes).toBe("recruiter called");
  });

  it("a change that can't apply is listed, the rest still go to approval", async () => {
    const mcp = await connectClient({ elicitation: false });
    const t = textOf(
      await mcp.call("propose_changes", {
        changes: [
          { action: "status", id: ids[2], status: "rejected" }, // already rejected
          { action: "add", company: "Stripe", role: "SDE" }, // already tracked
          { action: "status", id: ids[1], status: "oa" },
        ],
      }),
    );
    await mcp.close();
    expect(t).toMatch(/^Nothing has changed yet/);
    expect(t).toMatch(/Not included \(2\):\n- change 1: .*already "rejected".*\n- change 2: Already tracking/);
    expect(t).toContain("1 change to your tracker:");
  });

  it("deletes can't be batched", async () => {
    const mcp = await connectClient({ elicitation: false });
    const r = await mcp.call("propose_changes", { changes: [{ action: "delete", id: ids[0] }] });
    await mcp.close();
    expect(textOf(r)).toMatch(/Invalid/);
    expect(await count("pending_actions")).toBe(0);
  });
});
