// What the model sees when things go wrong: a clear isError result (tools) or a clean
// JSON-RPC error (resources), never a raw driver error, and the server keeps working.
// The pools are made to fail the way node-postgres does; db-down-process.test.ts does it
// for real, against a database that isn't there.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readPool, writePool } from "../../src/db/pool.js";
import { DB_UNAVAILABLE_MESSAGE } from "../../src/guard.js";
import { count, resetDb } from "../helpers/db.js";
import { ACCEPT, connectClient, textOf } from "../helpers/mcp.js";

const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54329"), { code: "ECONNREFUSED" });

let mcp: Awaited<ReturnType<typeof connectClient>>;

beforeAll(async () => {
  mcp = await connectClient({ elicitation: true });
});
afterAll(async () => {
  await mcp.close();
});
beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("database unavailable", () => {
  it("a read tool returns isError with a clear message, then recovers", async () => {
    vi.spyOn(readPool, "query").mockRejectedValue(refused() as never);

    const r = await mcp.call("list_applications");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(DB_UNAVAILABLE_MESSAGE);
    expect(textOf(r)).not.toMatch(/ECONNREFUSED|54329/);

    vi.restoreAllMocks(); // the database is back
    const again = await mcp.call("list_applications");
    expect(again.isError).toBeUndefined();
  });

  it("a write tool approved by the user returns isError, and nothing is saved", async () => {
    mcp.human.answer = ACCEPT;
    // pool.query() calls connect(callback) internally; transactions call connect() for a
    // promise. A real outage fails both ways.
    vi.spyOn(writePool, "connect").mockImplementation(((cb?: (err: Error) => void) => {
      if (cb) return void cb(refused());
      return Promise.reject(refused());
    }) as never);

    const r = await mcp.call("add_application", { company: "Stripe", role: "SDE" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(DB_UNAVAILABLE_MESSAGE);

    vi.restoreAllMocks();
    expect(await count("applications")).toBe(0);
  });

  it("a resource read fails with a clean JSON-RPC error", async () => {
    vi.spyOn(readPool, "query").mockRejectedValue(refused() as never);
    await expect(mcp.client.readResource({ uri: "jobhunt://pipeline" })).rejects.toThrow(/can't be reached/);
  });

  it("a prompt fails with a clean JSON-RPC error", async () => {
    vi.spyOn(readPool, "query").mockRejectedValue(refused() as never);
    await expect(mcp.client.getPrompt({ name: "weekly_followups", arguments: {} })).rejects.toThrow(/can't be reached/);
  });
});

describe("unexpected errors", () => {
  it("return a generic message with a reference, and leak nothing internal", async () => {
    const bug = Object.assign(new Error('relation "secret_internal_table" does not exist'), { code: "42P01" });
    vi.spyOn(readPool, "query").mockRejectedValue(bug as never);

    const r = await mcp.call("get_pipeline_summary");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Something went wrong on the server \(error ref [0-9a-f]{8}\)/);
    expect(textOf(r)).not.toMatch(/secret_internal_table|relation/);
  });

  it("a business error (ActionError) still reaches the model as written", async () => {
    const r = await mcp.call("update_application_status", { id: "00000000-0000-4000-8000-000000000000", status: "offer" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toMatch(/Something went wrong|can't be reached/);
  });
});
