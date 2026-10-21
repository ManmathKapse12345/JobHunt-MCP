// LinkedIn rows against the real tracker: what is already tracked is skipped, near matches
// are asked about, and long exports are split into approvable batches.
import { beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/db/tx.js";
import { executeAction, MAX_BATCH_ITEMS } from "../../src/hitl/actions.js";
import { type LinkedInApplication, proposeImport } from "../../src/imports/linkedin.js";
import { listAllApplications } from "../../src/repos/applications.js";
import { count, resetDb, seedApplication } from "../helpers/db.js";

const row = (company: string, role: string, appliedOn = "2026-09-01", url?: string): LinkedInApplication => ({ company, role, appliedOn, url });
type Item = { toolName: string; payload: Record<string, unknown>; summary: string };
const items = (p: { payload: unknown }) => (p.payload as { items: Item[] }).items;

beforeEach(async () => {
  await resetDb();
  await seedApplication({ company: "Stripe", role: "Backend Engineer" });
  await seedApplication({ company: "Google", role: "SDE" });
});

describe("proposeImport", () => {
  it("adds the new ones as applied via LinkedIn, oldest first, and skips what is tracked", async () => {
    const r = await proposeImport(
      [
        row("Notion", "Product Engineer", "2026-10-02", "https://www.linkedin.com/jobs/view/1"),
        row("Stripe Inc.", "backend engineer"), // tracked as Stripe / Backend Engineer
        row("Atlassian", "Frontend Engineer", "2026-08-15"),
      ],
      await listAllApplications(),
    );
    expect(r).toMatchObject({ alreadyTracked: 1, duplicates: 0, skipped: [] });
    expect(r.batches).toHaveLength(1);
    expect(items(r.batches[0]!).map((i) => i.payload)).toEqual([
      { company: "Atlassian", role: "Frontend Engineer", status: "applied", appliedAt: "2026-08-15", url: null, source: "LinkedIn", notes: null },
      { company: "Notion", role: "Product Engineer", status: "applied", appliedAt: "2026-10-02", url: "https://www.linkedin.com/jobs/view/1", source: "LinkedIn", notes: null },
    ]);
    expect(r.batches[0]!.summary).toMatch(/^2 applications from your LinkedIn export:/);
  });

  it("the same job twice in the export (applied again) is added once, with the first date", async () => {
    const r = await proposeImport([row("Notion", "SRE", "2026-10-02"), row("Notion", "SRE", "2026-07-01")], []);
    expect(r.duplicates).toBe(1);
    expect(items(r.batches[0]!).map((i) => i.payload.appliedAt)).toEqual(["2026-07-01"]);
  });

  it("different titles at one company are different jobs", async () => {
    const r = await proposeImport([row("Notion", "Software Engineer"), row("Notion", "Senior Software Engineer")], []);
    expect(items(r.batches[0]!)).toHaveLength(2);
  });

  it("a near match with the tracker is not added but listed, so the human decides", async () => {
    const r = await proposeImport([row("Google LLC", "SDE Intern")], await listAllApplications());
    expect(r.batches).toEqual([]);
    expect(r.skipped).toEqual([{ what: "SDE Intern at Google LLC", reason: expect.stringMatching(/^looks like "SDE" at Google, already tracked/) }]);
  });

  it(`more than ${MAX_BATCH_ITEMS} adds become several batches`, async () => {
    const many = Array.from({ length: MAX_BATCH_ITEMS + 5 }, (_, i) => row(`Company ${i}`, "Engineer"));
    const r = await proposeImport(many, []);
    expect(r.batches.map((b) => items(b).length)).toEqual([MAX_BATCH_ITEMS, 5]);
    expect(r.batches[1]!.summary).toMatch(/\(part 2 of 2\)/);
  });

  it("proposing changes nothing; approving applies them", async () => {
    const r = await proposeImport([row("Notion", "SRE"), row("Hooli", "SRE")], await listAllApplications());
    expect(await count("applications")).toBe(2);
    const b = r.batches[0]!;
    expect(await withTransaction((c) => executeAction(c, b.toolName, b.payload, "test"))).toBe("Applied 2 of 2 changes.");
    expect(await count("applications")).toBe(4);
  });
});
