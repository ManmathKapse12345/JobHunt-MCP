import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, seedApplication } from "../helpers/db.js";
import { connectClient, textOf } from "../helpers/mcp.js";

let mcp: Awaited<ReturnType<typeof connectClient>>;
let live: string;
let deleted: string;

beforeAll(async () => {
  mcp = await connectClient({ elicitation: false });
});
afterAll(async () => {
  await mcp.close();
});
beforeEach(async () => {
  await resetDb();
  live = await seedApplication({ company: "Stripe", role: "SDE", notes: "recruiter: Asha", quietDays: 10 });
  await seedApplication({ company: "Infosys", role: "Analyst", status: "interview", quietDays: 1 });
  deleted = await seedApplication({ company: "Zomato", role: "Backend", deleted: true });
});

const read = async (uri: string) =>
  (await mcp.client.readResource({ uri })).contents.map((c) => ("text" in c ? c.text : "")).join("\n");

describe("resources", () => {
  it("lists the pipeline and each live application, by name", async () => {
    const { resources } = await mcp.client.listResources();
    expect(resources.map((r) => [r.uri, r.title])).toEqual(
      expect.arrayContaining([
        ["jobhunt://pipeline", "Job Search Pipeline"],
        [`jobhunt://applications/${live}`, "SDE at Stripe"],
      ]),
    );
    expect(resources.map((r) => r.uri)).not.toContain(`jobhunt://applications/${deleted}`);
    const { resourceTemplates } = await mcp.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["jobhunt://applications/{id}"]);
  });

  it("jobhunt://pipeline reads the same as the get_pipeline_summary tool", async () => {
    expect(await read("jobhunt://pipeline")).toBe(textOf(await mcp.call("get_pipeline_summary")));
  });

  it("jobhunt://applications/{id} reads one application with history", async () => {
    const t = await read(`jobhunt://applications/${live}`);
    expect(t).toContain("- SDE at Stripe | applied");
    expect(t).toContain("Notes: recruiter: Asha");
    expect(t).toContain("created as applied");
  });

  it.each([
    ["an unknown id", "00000000-0000-4000-8000-000000000000"],
    ["a malformed id", "not-a-uuid"],
  ])("is 'not found' (-32002) for %s", async (_label, id) => {
    await expect(read(`jobhunt://applications/${id}`)).rejects.toThrow(/-32002/);
  });

  it("is 'not found' for a soft-deleted application", async () => {
    await expect(read(`jobhunt://applications/${deleted}`)).rejects.toThrow(/-32002/);
  });
});

describe("weekly_followups prompt", () => {
  it("declares string arguments, both optional", async () => {
    const { prompts } = await mcp.client.listPrompts();
    expect(prompts.find((p) => p.name === "weekly_followups")?.arguments?.map((a) => [a.name, a.required ?? false])).toEqual([
      ["days", false],
      ["tone", false],
    ]);
  });

  it("embeds the applications quiet for N days and the pipeline", async () => {
    const r = await mcp.client.getPrompt({ name: "weekly_followups", arguments: { days: "7", tone: "formal" } });
    const [first, second] = r.messages;
    const body = first?.content.type === "text" ? first.content.text : "";
    expect(body).toContain("Applications quiet for 7+ days:");
    expect(body).toContain("SDE at Stripe | applied | quiet 10 days");
    expect(body).toContain("notes: recruiter: Asha");
    expect(body).not.toContain("Infosys"); // quiet only 1 day
    expect(body).toContain("short formal follow-up");
    expect(second?.content).toMatchObject({ type: "resource", resource: { uri: "jobhunt://pipeline" } });
  });

  it("defaults to 7 days and a friendly tone, and handles nothing being quiet", async () => {
    const r = await mcp.client.getPrompt({ name: "weekly_followups", arguments: { days: "30" } });
    const body = JSON.stringify(r.messages[0]);
    expect(body).toContain("No open application has been quiet for 30+ days.");
    const d = JSON.stringify((await mcp.client.getPrompt({ name: "weekly_followups", arguments: {} })).messages[0]);
    expect(d).toContain("quiet for 7+ days");
    expect(d).toContain("friendly");
  });

  it.each(["a week", "0", "366", "-1"])("rejects days=%j", async (days) => {
    await expect(mcp.client.getPrompt({ name: "weekly_followups", arguments: { days } })).rejects.toThrow();
  });
});
