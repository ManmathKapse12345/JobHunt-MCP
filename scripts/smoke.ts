// Smoke test: starts the built server like Claude Desktop does and calls every tool.
// Run from the project root after `npm run build`:  npx tsx scripts/smoke.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { todayIso } from "../src/dates.js";
import { DatabaseSync } from "node:sqlite";   // add to imports

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

// A fresh temp folder, so the real data/applications.json is never touched.
const dir = await mkdtemp(path.join(tmpdir(), "jobhunt-smoke-"));
// const dataPath = path.join(dir, "applications.json");
const dataPath = path.join(dir, "jobhunt.db");  // was "applications.json"

const transport = new StdioClientTransport({
  command: process.execPath, // the same node.exe that runs this script
  args: ["dist/index.js"],
  env: { ...getDefaultEnvironment(), JOBHUNT_DATA_PATH: dataPath },
});
const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(transport);

// ---------- helpers ----------
async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

const readApps = async () => {
  const db = new DatabaseSync(dataPath, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM applications").all() as Array<Record<string, unknown>>;
  } finally {
    db.close(); // Windows won't delete an open file, so close before the cleanup at the end
  }
};
// Bad input can come back two ways: an isError result, or a thrown protocol error (-32602).
async function expectRejected(name: string, args: Record<string, unknown>, pattern: RegExp) {
  let result: ToolResult;
  try {
    result = await call(name, args);
  } catch (e) {
    assert.match(String(e), pattern);
    return;
  }
  assert.ok(result.isError, `expected an error, got: ${textOf(result)}`);
  assert.match(textOf(result), pattern);
}

let failures = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- tests ----------
try {
  await test("lists all 7 tools, read tools marked read-only", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "add_application",
      "days_since",
      "find_stale_applications",
      "get_application",
      "get_pipeline_summary",
      "list_applications",
      "ping",
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(readOnly, [
      "find_stale_applications",
      "get_application",
      "get_pipeline_summary",
      "list_applications",
    ]);
  });

  await test("adds a valid application and saves it to the file", async () => {
    const r = await call("add_application", { company: "Stripe", role: "Backend Engineer" });
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /^Saved: Backend Engineer at Stripe/);

    const apps = await readApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0]?.status, "applied");
    assert.equal(apps[0]?.appliedOn, todayIso()); // local date, not UTC
  });

  await test("rejects a duplicate (different case and spaces)", async () => {
    await expectRejected(
      "add_application",
      { company: "  stripe ", role: "backend engineer" },
      /Already tracking/,
    );
    assert.equal((await readApps()).length, 1, "duplicate must not be saved");
  });

  await test("rejects an impossible date", async () => {
    await expectRejected(
      "add_application",
      { company: "Acme", role: "SDE", appliedOn: "2026-02-30" },
      /Not a real calendar date/,
    );
  });

  await test("10 concurrent adds: no lost writes", async () => {
    const companies = Array.from({ length: 10 }, (_, i) => `Company ${i}`);
    const results = await Promise.all(
      companies.map((company) => call("add_application", { company, role: "SDE" })),
    );
    assert.ok(results.every((r) => !r.isError), "every add should succeed");
    assert.equal((await readApps()).length, 11, "1 Stripe + 10 new");
  });

  await test("days_since still works", async () => {
    assert.equal(textOf(await call("days_since", { date: todayIso() })), `0 days since ${todayIso()}`);
    assert.match(textOf(await call("days_since", { date: "2026-09-01" })), /^\d+ days since 2026-09-01$/);
  });

  // The read tools query Supabase (DATABASE_URL in .env), so these only check
  // that each query runs, not the exact rows.
  await test("get_pipeline_summary reads from Supabase", async () => {
    const r = await call("get_pipeline_summary", {});
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /^Total tracked: \d+/);
  });

  await test("list_applications and find_stale_applications run", async () => {
    for (const [name, args] of [
      ["list_applications", { limit: 5 }],
      ["list_applications", { status: "rejected" }],
      ["find_stale_applications", { days: 14 }],
    ] as const) {
      const r = await call(name, args);
      assert.ok(!r.isError, `${name}: ${textOf(r)}`);
    }
  });

  await test("get_application needs an id or a company", async () => {
    await expectRejected("get_application", {}, /Give either an id or a company name/);
    await expectRejected("get_application", { company: "No Such Company Ltd" }, /No application found/);
  });

  await test("list_applications rejects an unknown status", async () => {
    await expectRejected("list_applications", { status: "interviewing" }, /Invalid option/);
  });
} finally {
  await client.close(); // stops the server process
  await rm(dir, { recursive: true, force: true }); // deletes the temp data
}

console.log(failures ? `\n${failures} test(s) failed` : "\nAll tests passed");
process.exitCode = failures ? 1 : 0;