// Clients without elicitation get an approval LINK. Nothing changes until a human opens it
// and clicks Approve, and a link can be used only once.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApprovalHandler } from "../../src/hitl/approval-page.js";
import { setApprovalBaseUrl } from "../../src/hitl/links.js";
import { appRow, count, eventsOf, resetDb, seedApplication, snapshotDb } from "../helpers/db.js";
import { connectClient, textOf } from "../helpers/mcp.js";

let mcp: Awaited<ReturnType<typeof connectClient>>;
let server: http.Server;
let base = "";
let adminToken: string | undefined;

beforeAll(async () => {
  mcp = await connectClient({ elicitation: false });
  // The approval page, in-process, on a free port. adminToken is read per request so a
  // test can turn the sign-in requirement on.
  server = http.createServer((req, res) => {
    void createApprovalHandler({ origins: [base], adminToken })(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setApprovalBaseUrl(base);
});
afterAll(async () => {
  await mcp.close();
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  await resetDb();
  adminToken = undefined;
});

const linkIn = (text: string) => /(http:\/\/127\.0\.0\.1:\d+\/approve\/\S+)/.exec(text)?.[1] ?? "";

async function decide(link: string, decision: "approve" | "reject", headers: Record<string, string> = {}) {
  const url = new URL(link);
  const res = await fetch(`${url.origin}${url.pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ token: url.searchParams.get("token") ?? "", decision }),
  });
  return { status: res.status, body: await res.text() };
}

describe("without elicitation", () => {
  it("returns a link and changes nothing but the pending approval", async () => {
    const id = await seedApplication({ company: "Stripe", role: "SDE" });
    const before = await snapshotDb();

    const r = await mcp.call("update_application_status", { id, status: "offer" });
    expect(textOf(r)).toMatch(/^Nothing has changed yet: this needs the user's approval/);
    expect(linkIn(textOf(r))).toMatch(new RegExp(`^${base}/approve/[0-9a-f-]{36}\\?token=`));

    const after = await snapshotDb();
    expect({ ...after, pending_actions: [] }).toEqual({ ...before, pending_actions: [] });
    expect(after.pending_actions).toHaveLength(1);
  });

  it("approving the link applies the change exactly once, with an audit event", async () => {
    const link = linkIn(textOf(await mcp.call("add_application", { company: "Stripe", role: "SDE" })));
    expect(await count("applications")).toBe(0);

    const first = await decide(link, "approve");
    expect(first.body).toMatch(/Approved/);
    expect(await count("applications")).toBe(1);

    const second = await decide(link, "approve");
    expect(second.body).toMatch(/Already decided/);
    expect(await count("applications")).toBe(1);
    expect(await count("pending_actions", "status = 'approved'")).toBe(1);
  });

  it("rejecting the link changes nothing", async () => {
    const id = await seedApplication({ company: "Stripe", role: "SDE" });
    const link = linkIn(textOf(await mcp.call("delete_application", { id })));
    const before = await snapshotDb();

    expect((await decide(link, "reject")).body).toMatch(/Rejected/);
    expect((await appRow(id)).deleted_at).toBeNull();
    const after = await snapshotDb();
    expect({ ...after, pending_actions: [] }).toEqual({ ...before, pending_actions: [] });
  });

  it("a wrong token or a foreign Origin changes nothing", async () => {
    const id = await seedApplication({ company: "Stripe", role: "SDE" });
    const link = linkIn(textOf(await mcp.call("update_application_status", { id, status: "oa" })));

    expect((await decide(link.replace(/token=.*/, "token=wrong"), "approve")).status).toBe(404);
    expect((await decide(link, "approve", { Origin: "http://evil.example" })).status).toBe(403);
    expect((await decide(link, "approve", { Origin: "null" })).status).toBe(403);
    expect((await appRow(id)).status).toBe("applied");
  });

  it("with an admin token, approving without signing in changes nothing", async () => {
    adminToken = "test-admin-token-123";
    const id = await seedApplication({ company: "Stripe", role: "SDE" });
    const link = linkIn(textOf(await mcp.call("update_application_status", { id, status: "oa" })));

    const page = await fetch(link);
    expect(await page.text()).toMatch(/Sign in to approve/);
    expect((await decide(link, "approve")).status).toBe(401);
    expect((await appRow(id)).status).toBe("applied");
    expect(await eventsOf(id)).toHaveLength(1); // only "created"
  });
});
