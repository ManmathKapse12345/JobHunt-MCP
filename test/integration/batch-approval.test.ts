// Changes proposed from email, approved together on one page: the human ticks which ones
// apply, and one that no longer applies is undone alone (a savepoint per item).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writePool } from "../../src/db/pool.js";
import { selectTracked } from "../../src/google/classify.js";
import { matchOpportunities } from "../../src/google/match.js";
import { withTransaction } from "../../src/db/tx.js";
import { ActionError, executeAction, type Prepared, prepareBatch } from "../../src/hitl/actions.js";
import { listClassifiedEmails } from "../../src/repos/email-messages.js";
import { proposeFromMatches, sourceOf } from "../../src/google/proposals.js";
import { syncJobEmails } from "../../src/google/sync.js";
import { createApprovalHandler } from "../../src/hitl/approval-page.js";
import { setApprovalBaseUrl } from "../../src/hitl/links.js";
import { createApprovalLink } from "../../src/hitl/requireApproval.js";
import { listAllApplications } from "../../src/repos/applications.js";
import { upsertGmailConnection } from "../../src/repos/gmail-connections.js";
import { getPendingAction } from "../../src/repos/pending-actions.js";
import { appRow, count, eventsOf, resetDb, seedApplication } from "../helpers/db.js";
import { email, fakeGmailSource, fixtureEmails } from "../helpers/fake-gmail-source.js";

let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => void createApprovalHandler({ origins: [base] })(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setApprovalBaseUrl(base);
});
afterAll(() => new Promise((r) => server.close(r)));

let acmeId: string;

// Acme: tracked as applied, and an interview email since. Globex: confirmed, not tracked.
// Google: confirmed, two applications there and no role in the email. Initech: no confirmation.
beforeEach(async () => {
  await resetDb();
  acmeId = await seedApplication({ company: "Acme Robotics", role: "Software Engineer Intern" });
  await seedApplication({ company: "Google", role: "Software Engineer" });
  await seedApplication({ company: "Google", role: "Data Analyst" });
  const { id } = await upsertGmailConnection({ email: "me@gmail.com", refreshTokenEnc: "v1.iv.body", scopes: "gmail.readonly" });
  const inbox = fakeGmailSource([
    ...fixtureEmails(),
    email({ id: "a2", threadId: "t-18f0a1", from: "Acme Robotics <talent@acmerobotics.com>", subject: "Interview invitation at Acme Robotics", receivedAt: new Date("2026-10-16T06:00:00Z") }),
    email({ id: "g1", from: "Google <no-reply@google.com>", subject: "Thank you for applying to Google", receivedAt: new Date("2026-10-14T06:00:00Z") }),
  ]);
  await syncJobEmails(inbox, id);
});

// What npm run gmail:propose does, from the stored emails.
async function propose() {
  const { rows } = await writePool.query<{ id: string }>("select id from gmail_connections");
  const { opportunities } = selectTracked(await listClassifiedEmails(rows[0]!.id));
  return proposeFromMatches(matchOpportunities(opportunities, await listAllApplications()));
}

type Items = Array<{ toolName: string; payload: unknown; summary: string }>;
const itemsOf = (p: Prepared) => (p.payload as { items: Items }).items;

async function decide(link: string, fields: Array<[string, string]>) {
  const url = new URL(link);
  const res = await fetch(`${url.origin}${url.pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([["token", url.searchParams.get("token") ?? ""], ...fields]),
  });
  return res.text();
}

describe("proposing changes from email", () => {
  it("one batch: a status change for the linked application, an add for the untracked one", async () => {
    const { batch, skipped } = await propose();
    expect(batch!.toolName).toBe("apply_batch");
    expect(itemsOf(batch!)).toEqual([
      expect.objectContaining({ toolName: "update_application_status", payload: expect.objectContaining({ id: acmeId, from: "applied", to: "interview", note: "From Gmail: interview email on 2026-10-16" }) }),
      expect.objectContaining({ toolName: "add_application", payload: expect.objectContaining({ company: "Globex", role: "Role not stated", status: "applied", appliedAt: "2026-10-12", source: "Indeed" }) }),
    ]);
    expect(batch!.summary).toMatch(/^2 changes from your job emails:\n1\. Change the status of "Software Engineer Intern" at Acme Robotics: applied -> interview/);
    // Never a guess between two Google applications.
    expect(skipped).toEqual([{ organization: "Google", reason: expect.stringMatching(/^2 applications could be this/) }]);
  });

  it("proposing changes nothing", async () => {
    await propose();
    expect(await count("applications")).toBe(3);
    expect((await appRow(acmeId)).status).toBe("applied");
  });

  it("nothing to do once the tracker matches", async () => {
    await writePool.query("update applications set status = 'interview' where id = $1", [acmeId]);
    await seedApplication({ company: "Globex", role: "Backend Developer" });
    expect((await propose()).batch).toBeNull();
  });
});

describe("approving a batch", () => {
  it("shows one ticked checkbox per change", async () => {
    const link = await createApprovalLink((await propose()).batch!);
    const html = await (await fetch(link.url)).text();
    expect(html).toContain("Approve 2 changes?");
    expect(html.match(/type="checkbox" name="item"/g)).toHaveLength(2);
  });

  it("applies only the ticked ones", async () => {
    const link = await createApprovalLink((await propose()).batch!);
    const body = await decide(link.url, [["item", "1"], ["decision", "approve"]]);
    expect(body).toContain("Applied 1 of 2 changes; 1 not ticked.");
    expect((await appRow(acmeId)).status).toBe("applied"); // unticked
    expect(await count("applications")).toBe(4); // Globex added

    const row = await getPendingAction(link.id);
    expect(row).toMatchObject({ status: "approved", error: null });
    expect((row!.result as { items: Array<{ outcome: string }> }).items.map((i) => i.outcome)).toEqual(["skipped", "applied"]);
    // Used once.
    expect(await decide(link.url, [["item", "0"], ["decision", "approve"]])).toMatch(/Already decided/);
    expect((await appRow(acmeId)).status).toBe("applied");
  });

  it("a change that no longer applies is undone alone; the others still apply", async () => {
    const link = await createApprovalLink((await propose()).batch!);
    // Meanwhile, Acme moved on by hand.
    await writePool.query("update applications set status = 'rejected' where id = $1", [acmeId]);

    const body = await decide(link.url, [["item", "0"], ["item", "1"], ["decision", "approve"]]);
    expect(body).toContain("Applied 1 of 2 changes; 1 no longer applied and were left as they were.");
    expect(body).toContain("The application is no longer &#34;applied&#34;");
    expect((await appRow(acmeId)).status).toBe("rejected");
    // The add went in, with its audit event, approved by the link.
    const { rows } = await writePool.query<{ id: string }>(
      "select a.id from applications a join companies c on c.id = a.company_id where c.name = 'Globex'",
    );
    expect((await eventsOf(rows[0]!.id))[0]).toMatchObject({ kind: "created", actor: "user via approval link" });
  });

  it("a database error in one item (a duplicate) doesn't abort the items after it", async () => {
    // The add first this time, and Globex added by hand meanwhile: the insert hits the
    // unique index, which would abort the whole transaction without the savepoint.
    const proposed = itemsOf((await propose()).batch!);
    const batch = prepareBatch("reordered", [...proposed].reverse() as Prepared[]);
    const link = await createApprovalLink(batch);
    await seedApplication({ company: "Globex", role: "Role not stated" });

    const body = await decide(link.url, [["item", "0"], ["item", "1"], ["decision", "approve"]]);
    expect(body).toContain("Applied 1 of 2 changes; 1 no longer applied");
    expect(body).toContain("is already tracked");
    expect((await appRow(acmeId)).status).toBe("interview");
    expect(await count("applications")).toBe(4);
  });

  it("reject all, or approve with nothing ticked: nothing changes", async () => {
    for (const fields of [[["decision", "reject"]], [["decision", "approve"]]] as Array<Array<[string, string]>>) {
      const link = await createApprovalLink((await propose()).batch!);
      expect(await decide(link.url, fields)).toMatch(/Rejected/);
      expect(await getPendingAction(link.id)).toMatchObject({ status: "rejected" });
    }
    expect(await count("applications")).toBe(3);
    expect((await appRow(acmeId)).status).toBe("applied");
  });
});

describe("apply_batch as one action", () => {
  it("approved as a whole (an elicitation yes): every item applies", async () => {
    const batch = (await propose()).batch!;
    const message = await withTransaction((c) => executeAction(c, batch.toolName, batch.payload, "test"));
    expect(message).toBe("Applied 2 of 2 changes.");
    expect((await appRow(acmeId)).status).toBe("interview");
    expect(await count("applications")).toBe(4);
  });

  it("only adds and edits can be batched: never a delete, never a batch inside a batch", async () => {
    for (const toolName of ["delete_application", "apply_batch"]) {
      const bad = { items: [{ toolName, payload: { id: acmeId, reason: null }, summary: "x" }] };
      await expect(withTransaction((c) => executeAction(c, "apply_batch", bad, "test"))).rejects.toThrow(ActionError);
      expect(() => prepareBatch("x", [{ toolName, payload: {}, summary: "x" }])).toThrow();
    }
    expect(await count("applications")).toBe(3);
  });
});

describe("sourceOf", () => {
  it.each([
    ["LinkedIn <jobs-noreply@linkedin.com>", "LinkedIn"],
    ["Indeed <noreply@indeed.com>", "Indeed"],
    ["Internshala <student@mailer.internshala.com>", "Internshala"],
    ["Globex Hiring <no-reply@greenhouse-mail.io>", undefined],
    ["someone@notlinkedin.com", undefined],
  ])("%s -> %s", (from, want) => expect(sourceOf(from)).toBe(want));
});
