// Smoke test: starts the built server like Claude does and calls every tool (through BOTH
// approval paths), resource and prompt, then checks the mcp_reader role's limits.
// Run from the project root:  npm run smoke  (or npm test)
//
// It talks to the database in DATABASE_URL (your Supabase project, from .env). Every row
// it creates belongs to a company named "zz Smoke Test <run id>" and is removed at the end.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { todayIso } from "../src/dates.js";
import { closePools, readerConfigured, readPool, writePool as pool } from "../src/db/pool.js";
import { call, cleanupCompany, failureCount, idOf, request, test, textOf, tokenOf, type ToolResult } from "./helpers.js";

const RUN = randomBytes(3).toString("hex");
const COMPANY = `zz Smoke Test ${RUN}`;

// ---------- two clients, two server processes ----------

function serverEnv(): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    APPROVAL_PORT: "0", // any free port, so tests never clash with Claude's running server
    ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
    ...(process.env.DATABASE_URL_READER ? { DATABASE_URL_READER: process.env.DATABASE_URL_READER } : {}),
  };
}

async function connect(name: string, withElicitation: boolean): Promise<Client> {
  const client = new Client(
    { name, version: "0.0.1" },
    { capabilities: withElicitation ? { elicitation: {} } : {} },
  );
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: serverEnv() }),
  );
  return client;
}

// "elicit" plays a user answering the approval form; "plain" has no elicitation support.
const elicit = await connect("smoke-elicit", true);
const plain = await connect("smoke-plain", false);

// What the fake user answers next, and every message they were shown.
let nextAnswer: ElicitResult = { action: "decline" };
const shown: string[] = [];
elicit.setRequestHandler(ElicitRequestSchema, async (req) => {
  shown.push(String(req.params.message));
  return nextAnswer;
});
const ACCEPT: ElicitResult = { action: "accept", content: { approve: true } };

// ---------- helpers ----------

// Bad input can come back two ways: an isError result, or a thrown protocol error (-32602).
async function expectRejected(client: Client, name: string, args: Record<string, unknown>, pattern: RegExp) {
  let result: ToolResult;
  try {
    result = await call(client, name, args);
  } catch (e) {
    assert.match(String(e), pattern);
    return;
  }
  assert.ok(result.isError, `expected an error, got: ${textOf(result)}`);
  assert.match(textOf(result), pattern);
}

const linkOf = (r: ToolResult) => /(http:\/\/127\.0\.0\.1:\d+\/approve\/\S+)/.exec(textOf(r))?.[1] ?? assert.fail(textOf(r));

async function appRow(id: string) {
  const { rows } = await pool.query(
    "select status, notes, deleted_at, applied_at from applications where id = $1",
    [id],
  );
  return rows[0];
}
async function lastEvent(id: string) {
  const { rows } = await pool.query(
    "select kind, from_status, to_status, actor, note, details from events where application_id = $1 order by occurred_at desc, kind desc limit 1",
    [id],
  );
  return rows[0];
}
async function pendingOf(link: string) {
  const id = new URL(link).pathname.split("/").pop();
  const { rows } = await pool.query("select status, result, error from pending_actions where id = $1", [id]);
  return rows[0];
}

const decide = (link: string, decision: "approve" | "reject") =>
  request(link.split("?")[0]!, { method: "POST", form: { token: tokenOf(link), decision } });

// ---------- tests ----------
try {
  await test("lists all 10 tools with the right annotations", async () => {
    const { tools } = await plain.listTools();
    const names = (pred: (t: (typeof tools)[number]) => boolean) =>
      tools.filter(pred).map((t) => t.name).sort();
    assert.deepEqual(names(() => true), [
      "add_application",
      "days_since",
      "delete_application",
      "find_stale_applications",
      "get_application",
      "get_pipeline_summary",
      "list_applications",
      "ping",
      "update_application",
      "update_application_status",
    ]);
    assert.deepEqual(names((t) => t.annotations?.readOnlyHint === true), [
      "find_stale_applications",
      "get_application",
      "get_pipeline_summary",
      "list_applications",
    ]);
    assert.deepEqual(names((t) => t.annotations?.destructiveHint === true), [
      "delete_application",
      "update_application",
      "update_application_status",
    ]);
  });

  // ----- path 1: elicitation -----

  let appId = "";
  await test("elicitation accept: add_application saves the row and an audit event", async () => {
    nextAnswer = ACCEPT;
    const r = await call(elicit, "add_application", { company: COMPANY, role: "SDE", source: "smoke" });
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /^The user approved\. Added "SDE" at zz Smoke Test/);
    assert.match(shown.at(-1) ?? "", new RegExp(`Add a new application: "SDE" at ${COMPANY}`));
    appId = idOf(r);
    const row = await appRow(appId);
    assert.equal(row.status, "applied");
    assert.equal(row.applied_at, todayIso());
    const ev = await lastEvent(appId);
    assert.equal(ev.kind, "created");
    assert.equal(ev.actor, "user via elicitation (smoke-elicit)");
  });

  await test("duplicate add is refused before asking the user", async () => {
    const asked = shown.length;
    await expectRejected(elicit, "add_application", { company: ` ${COMPANY.toUpperCase()} `, role: "sde" }, /Already tracking/);
    assert.equal(shown.length, asked, "the user must not be asked about an impossible change");
  });

  await test("elicitation decline / unticked: nothing changes", async () => {
    nextAnswer = { action: "decline" };
    let r = await call(elicit, "update_application_status", { id: appId, status: "oa" });
    assert.match(textOf(r), /did not approve \(decline\)\. Nothing was changed/);
    nextAnswer = { action: "accept", content: { approve: false } };
    r = await call(elicit, "update_application_status", { id: appId, status: "oa" });
    assert.match(textOf(r), /did not approve \(left unticked\)/);
    assert.equal((await appRow(appId)).status, "applied");
  });

  await test("elicitation accept: status change is logged with actor and note", async () => {
    nextAnswer = ACCEPT;
    const r = await call(elicit, "update_application_status", { id: appId, status: "oa", note: "OA mail" });
    assert.match(textOf(r), /is now "oa"/);
    assert.equal((await appRow(appId)).status, "oa");
    const ev = await lastEvent(appId);
    assert.deepEqual([ev.kind, ev.from_status, ev.to_status, ev.note], ["status_change", "applied", "oa", "OA mail"]);
    assert.match(ev.actor, /elicitation/);
  });

  await test("update_application edits notes and audits before/after", async () => {
    nextAnswer = ACCEPT;
    const r = await call(elicit, "update_application", { id: appId, notes: "recruiter: Asha" });
    assert.match(textOf(r), /Updated notes/);
    assert.match(shown.at(-1) ?? "", /notes: \(empty\) -> "recruiter: Asha"/);
    assert.equal((await appRow(appId)).notes, "recruiter: Asha");
    const ev = await lastEvent(appId);
    assert.equal(ev.kind, "updated");
    assert.deepEqual(ev.details, { before: { notes: null }, after: { notes: "recruiter: Asha" } });
    await expectRejected(elicit, "update_application", { id: appId, notes: "recruiter: Asha" }, /Nothing to change/);
  });

  // ----- path 2: approval link -----

  await test("no elicitation: delete returns a link and changes nothing yet", async () => {
    const r = await call(plain, "delete_application", { id: appId, reason: "smoke test" });
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /Nothing has changed yet/);
    const link = linkOf(r);
    assert.equal((await appRow(appId)).deleted_at, null);
    assert.equal((await pendingOf(link)).status, "pending");

    const page = await request(link);
    assert.equal(page.status, 200);
    // Not "no-referrer": browsers would then send "Origin: null" when you click Approve.
    assert.equal(page.headers["referrer-policy"], "same-origin");
    assert.match(page.body, /Approve this change\?/);
    assert.match(page.body, /zz Smoke Test/);

    // Guards: wrong token, foreign Host (DNS rebinding), foreign Origin (CSRF).
    assert.equal((await request(link.replace(/token=.*/, "token=wrong"))).status, 404);
    assert.equal((await request(link, { headers: { Host: "evil.example" } })).status, 403);
    const csrf = await request(link.split("?")[0]!, {
      method: "POST",
      form: { token: tokenOf(link), decision: "approve" },
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(csrf.status, 403);
    assert.equal((await appRow(appId)).deleted_at, null, "guards must not let anything through");

    // The real click.
    const done = await decide(link, "approve");
    assert.match(done.body, /Approved/);
    assert.notEqual((await appRow(appId)).deleted_at, null);
    const ev = await lastEvent(appId);
    assert.deepEqual([ev.kind, ev.actor, ev.note], ["deleted", "user via approval link", "smoke test"]);
    const pending = await pendingOf(link);
    assert.equal(pending.status, "approved");
    assert.match(pending.result.message, /^Deleted/);

    // A second click does nothing; the row is now invisible to read tools.
    assert.match((await decide(link, "approve")).body, /Already decided/);
    await expectRejected(plain, "get_application", { id: appId }, /No application with id/);
  });

  await test("no elicitation: rejecting a link writes nothing", async () => {
    const r = await call(plain, "add_application", { company: COMPANY, role: "Rejected Role" });
    const link = linkOf(r);
    assert.match((await decide(link, "reject")).body, /Rejected/);
    assert.equal((await pendingOf(link)).status, "rejected");
    const { rowCount } = await pool.query(
      "select 1 from applications a join companies c on c.id = a.company_id where c.name = $1 and a.role = 'Rejected Role'",
      [COMPANY],
    );
    assert.equal(rowCount, 0);
  });

  await test("a link approved after the data changed is refused, not applied", async () => {
    nextAnswer = ACCEPT;
    const id = idOf(await call(elicit, "add_application", { company: COMPANY, role: "Race" }));
    const link = linkOf(await call(plain, "update_application_status", { id, status: "interview" }));
    await call(elicit, "update_application_status", { id, status: "rejected" }); // meanwhile...
    assert.match((await decide(link, "approve")).body, /Could not apply/);
    assert.equal((await appRow(id)).status, "rejected");
    const pending = await pendingOf(link);
    assert.equal(pending.status, "approved");
    assert.match(pending.error, /no longer "applied"/);
  });

  // ----- read + utility tools still work -----

  await test("read tools and utilities", async () => {
    assert.match(textOf(await call(plain, "get_pipeline_summary", {})), /^Total tracked: \d+/);
    for (const [name, args] of [
      ["list_applications", { limit: 5 }],
      ["find_stale_applications", { days: 14 }],
      ["ping", {}],
    ] as const) {
      const r = await call(plain, name, args);
      assert.ok(!r.isError, `${name}: ${textOf(r)}`);
    }
    assert.equal(textOf(await call(plain, "days_since", { date: todayIso() })), `0 days since ${todayIso()}`);
    await expectRejected(plain, "list_applications", { status: "interviewing" }, /Invalid option/);
    await expectRejected(plain, "get_application", {}, /Give either an id or a company name/);
  });

  // ----- resources -----

  const resourceText = async (uri: string) => {
    const { contents } = await plain.readResource({ uri });
    return contents.map((c) => ("text" in c ? c.text : "")).join("\n");
  };

  await test("resources: jobhunt://pipeline matches the tool, the template lists and reads applications", async () => {
    const { resourceTemplates } = await plain.listResourceTemplates();
    assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate), ["jobhunt://applications/{id}"]);

    assert.equal(
      await resourceText("jobhunt://pipeline"),
      textOf(await call(plain, "get_pipeline_summary", {})),
    );

    nextAnswer = ACCEPT;
    const id = idOf(await call(elicit, "add_application", { company: COMPANY, role: "Resource Role", notes: "via resource" }));
    const uri = `jobhunt://applications/${id}`;
    const { resources } = await plain.listResources();
    const uris = resources.map((r) => r.uri);
    assert.ok(uris.includes("jobhunt://pipeline"), "static resource listed");
    assert.ok(uris.includes(uri), "the template's list callback includes the new application");
    assert.equal(resources.find((r) => r.uri === uri)?.name, `Resource Role at ${COMPANY}`);
    assert.equal(resources.find((r) => r.uri === uri)?.title, `Resource Role at ${COMPANY}`);

    const detail = await resourceText(uri);
    assert.match(detail, /Resource Role at zz Smoke Test/);
    assert.match(detail, /Notes: via resource/);
    assert.match(detail, /History:\n- \d{4}-\d{2}-\d{2}: created as applied/);

    // Unknown, malformed and soft-deleted ids are all "not found" (-32002).
    await assert.rejects(resourceText("jobhunt://applications/00000000-0000-4000-8000-000000000000"), /-32002/);
    await assert.rejects(resourceText("jobhunt://applications/not-a-uuid"), /-32002/);
    await assert.rejects(resourceText(`jobhunt://applications/${appId}`), /-32002/);
  });

  // ----- prompts -----

  await test("prompts: weekly_followups takes string arguments and embeds live data", async () => {
    const { prompts } = await plain.listPrompts();
    const p = prompts.find((x) => x.name === "weekly_followups");
    assert.ok(p, "weekly_followups is listed");
    assert.deepEqual(
      p.arguments?.map((a) => [a.name, a.required ?? false]),
      [["days", false], ["tone", false]],
    );

    const r = await plain.getPrompt({ name: "weekly_followups", arguments: { days: "3", tone: "formal" } });
    const first = r.messages[0]!.content;
    assert.equal(first.type, "text");
    assert.match(first.type === "text" ? first.text : "", /Applications quiet for 3\+ days/);
    const second = r.messages[1]!.content;
    assert.equal(second.type, "resource");
    assert.match(second.type === "resource" && "text" in second.resource ? second.resource.text : "", /^Total tracked/);

    const defaults = await plain.getPrompt({ name: "weekly_followups", arguments: {} });
    assert.match(JSON.stringify(defaults.messages[0]), /quiet for 7\+ days/);

    await assert.rejects(plain.getPrompt({ name: "weekly_followups", arguments: { days: "a week" } }), /whole number/);
    await assert.rejects(plain.getPrompt({ name: "weekly_followups", arguments: { days: "0" } }));
  });

  // ----- the mcp_reader role (supabase/migrations/003_mcp_reader.sql) -----

  if (!readerConfigured) {
    console.log("⚠️  mcp_reader checks skipped: DATABASE_URL_READER is not set (reads use DATABASE_URL)");
  } else {
    await test("mcp_reader: sees live rows, cannot write, cannot read approvals", async () => {
      const who = await readPool.query<{ u: string; ro: string }>(
        "select current_user as u, current_setting('transaction_read_only') as ro",
      );
      assert.deepEqual([who.rows[0]!.u, who.rows[0]!.ro], ["mcp_reader", "on"]);

      // RLS policies let it see live applications (without them it would see 0 rows)...
      const live = "select count(*)::int as n from applications where deleted_at is null";
      const [asReader, asWriter] = await Promise.all([readPool.query(live), pool.query(live)]);
      assert.equal(asReader.rows[0].n, asWriter.rows[0].n);
      // ...but never soft-deleted ones, even when the query does not filter them out.
      assert.equal((await readPool.query("select 1 from applications where id = $1", [appId])).rowCount, 0);

      // Layer 1: every transaction is read-only by default (25006).
      await assert.rejects(readPool.query("insert into companies (name) values ('zz nope')"), { code: "25006" });
      // Layer 2: even in an explicit read-write transaction, there is no INSERT/UPDATE grant (42501).
      const c = await readPool.connect();
      try {
        await c.query("begin read write");
        await assert.rejects(c.query("insert into companies (name) values ('zz nope')"), { code: "42501" });
        await c.query("rollback");
        await c.query("begin read write");
        await assert.rejects(c.query("update applications set notes = 'x' where id = $1", [appId]), { code: "42501" });
      } finally {
        await c.query("rollback");
        c.release();
      }
      // No grant on pending_actions (approval token hashes) or contacts.
      await assert.rejects(readPool.query("select * from pending_actions limit 1"), { code: "42501" });
      await assert.rejects(readPool.query("select * from contacts limit 1"), { code: "42501" });
    });
  }
} finally {
  await Promise.all([elicit.close(), plain.close()]); // stops both server processes
  await cleanupCompany(pool, COMPANY);
  await closePools();
}

const failures = failureCount();
console.log(failures ? `\n${failures} test(s) failed` : "\nAll tests passed");
process.exitCode = failures ? 1 : 0;
