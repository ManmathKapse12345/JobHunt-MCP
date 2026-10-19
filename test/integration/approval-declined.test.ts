// THE key property of the human-in-the-loop design: when the human does not approve, a
// write tool changes NOTHING. Checked for every write tool and every way of saying no,
// against a full snapshot of every table the write path can touch.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { count, resetDb, seedApplication, snapshotDb } from "../helpers/db.js";
import { CANCEL, connectClient, DECLINE, textOf, UNTICKED } from "../helpers/mcp.js";

let mcp: Awaited<ReturnType<typeof connectClient>>;
let appId: string;

beforeAll(async () => {
  mcp = await connectClient({ elicitation: true });
});
afterAll(async () => {
  await mcp.close();
});
beforeEach(async () => {
  await resetDb();
  appId = await seedApplication({ company: "Stripe", role: "SDE", notes: "original", quietDays: 5 });
  await seedApplication({ company: "Infosys", role: "SDE", status: "rejected" });
  mcp.human.asked = [];
});

// One valid call per write tool (each would change something if approved).
const writes: [string, () => Record<string, unknown>][] = [
  ["add_application", () => ({ company: "NewCo", role: "Backend Engineer", notes: "x" })],
  ["update_application_status", () => ({ id: appId, status: "interview", note: "x" })],
  ["update_application", () => ({ id: appId, notes: "changed", role: "Senior SDE" })],
  ["delete_application", () => ({ id: appId, reason: "x" })],
];

const noes: [string, ElicitResult, RegExp][] = [
  ["declines", DECLINE, /did not approve \(decline\)/],
  ["cancels", CANCEL, /did not approve \(cancel\)/],
  ["accepts but leaves the box unticked", UNTICKED, /did not approve \(left unticked\)/],
];

describe.each(writes)("%s", (tool, args) => {
  it.each(noes)("changes nothing when the human %s", async (_label, answer, message) => {
    const before = await snapshotDb();
    mcp.human.answer = answer;

    const r = await mcp.call(tool, args());

    // The human really was asked (so this can't pass just because the tool failed early)...
    expect(mcp.human.asked).toHaveLength(1);
    // ...the model is told plainly that nothing happened...
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(message);
    expect(textOf(r)).toMatch(/Nothing was changed\.$/);
    // ...and every row of every table is exactly as before, down to updated_at.
    expect(await snapshotDb()).toEqual(before);
  });
});

it("an elicitation that fails falls back to an approval link, still without applying anything", async () => {
  // e.g. the client crashes or rejects the request: requireApproval must not treat that as a yes.
  const failing = await connectClient({ elicitation: true });
  failing.client.setRequestHandler(
    (await import("@modelcontextprotocol/sdk/types.js")).ElicitRequestSchema,
    async () => {
      throw new Error("client broke");
    },
  );
  try {
    const before = await snapshotDb();
    const r = await failing.call("update_application_status", { id: appId, status: "offer" });
    expect(textOf(r)).toMatch(/^Nothing has changed yet: this needs the user's approval/);

    const after = await snapshotDb();
    // The only difference: one pending approval waiting for a human.
    expect({ ...after, pending_actions: [] }).toEqual({ ...before, pending_actions: [] });
    expect(await count("pending_actions", "status = 'pending'")).toBe(1);
  } finally {
    await failing.close();
  }
});
