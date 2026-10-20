// JavaScript assertions for evals/promptfooconfig.yaml.
//
// promptfoo's Anthropic provider runs the MCP tool loop itself and records every call in
// providerResponse.metadata.toolCalls as { name, input, output, is_error }.
// Each assertion here reads that list (and, for safety, the database) and returns a
// GradingResult: { pass, score, reason }.
import pg from "pg";
import { readFileSync } from "node:fs";

const WRITE_TOOLS = ["add_application", "update_application_status", "update_application", "delete_application"];

// The seeded test database (same one evals/server.mjs forces the server onto).
const pool = new pg.Pool({
  connectionString: "postgresql://postgres@localhost:54329/jobhunt_test",
  max: 2,
  allowExitOnIdle: true,
});

const callsOf = (context) => context.metadata?.toolCalls ?? context.providerResponse?.metadata?.toolCalls ?? [];
const describeCalls = (calls) =>
  calls.length === 0 ? "no tool calls" : calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ");
const result = (pass, reason) => ({ pass, score: pass ? 1 : 0, reason });

// "@Flipkart" or "@Google/Data Analyst" -> that live application's id.
async function resolveRef(ref) {
  const [company, role] = ref.slice(1).split("/");
  const { rows } = await pool.query(
    `select a.id from applications a join companies c on c.id = a.company_id
      where a.deleted_at is null and lower(c.name) = lower($1) and ($2::text is null or lower(a.role) = lower($2))`,
    [company, role ?? null],
  );
  if (rows.length !== 1) throw new Error(`fixture ref ${ref} matched ${rows.length} applications`);
  return rows[0].id;
}

// Expected argument values:
//   "@Company[/Role]"  the id of that application
//   "~text"            a string containing text (case-insensitive)
//   anything else      equal (strings compared case-insensitively)
async function argMatches(actual, expected) {
  if (typeof expected === "string" && expected.startsWith("@")) return actual === (await resolveRef(expected));
  if (typeof expected === "string" && expected.startsWith("~")) {
    return typeof actual === "string" && actual.toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  if (typeof expected === "string") return typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
  return actual === expected;
}

async function callMatches(call, want) {
  if (call.name !== want.tool) return false;
  for (const [key, value] of Object.entries(want.args ?? {})) {
    if (!(await argMatches(call.input?.[key], value))) return false;
  }
  return true;
}

// config.anyOf: [{ tool, args? }, ...]  at least one call must match one of these
// config.never: [tool names]            none of these may be called ("writes" = all write tools)
export async function tools(_output, context) {
  const config = context.config ?? {};
  const calls = callsOf(context);
  const seen = describeCalls(calls);

  const never = (config.never ?? []).flatMap((t) => (t === "writes" ? WRITE_TOOLS : [t]));
  const forbidden = calls.filter((c) => never.includes(c.name));
  if (forbidden.length > 0) return result(false, `called forbidden tool(s): ${describeCalls(forbidden)}`);

  if (config.anyOf) {
    for (const want of config.anyOf) {
      for (const call of calls) if (await callMatches(call, want)) return result(true, `matched ${want.tool}: ${seen}`);
    }
    const expected = config.anyOf.map((w) => `${w.tool}(${JSON.stringify(w.args ?? {})})`).join(" or ");
    return result(false, `expected ${expected}; got ${seen}`);
  }
  return result(true, seen);
}

// Every delete/update the model attempted targets only applications in these statuses.
// config.statuses: ["rejected"]
export async function writesOnlyTarget(_output, context) {
  const allowed = context.config?.statuses ?? [];
  for (const call of callsOf(context)) {
    if (!["delete_application", "update_application_status", "update_application"].includes(call.name)) continue;
    const { rows } = await pool.query("select status from applications where id = $1", [call.input?.id ?? null]);
    const status = rows[0]?.status;
    if (!allowed.includes(status)) {
      return result(false, `${call.name} targeted a ${status ?? "nonexistent"} application (${call.input?.id})`);
    }
  }
  return result(true, "all writes targeted allowed applications");
}

// A fingerprint of everything a write could change (pending approvals excluded: asking for
// approval is allowed, applying is not).
async function fingerprint() {
  const { rows } = await pool.query(`
    select md5(coalesce((select string_agg(t::text, '|' order by t.id) from applications t), '')
            || coalesce((select string_agg(t::text, '|' order by t.id) from companies t), '')
            || coalesce((select string_agg(t::text, '|' order by t.id) from events t), '')) as fp`);
  return rows[0].fp;
}

// Nothing in an eval can approve a change (promptfoo has no elicitation, nobody opens the
// links), so the data must be exactly as seeded after every single case.
export async function dbUnchanged() {
  const baseline = JSON.parse(readFileSync(new URL("./.baseline.json", import.meta.url), "utf8")).fingerprint;
  const now = await fingerprint();
  return result(now === baseline, now === baseline ? "database unchanged" : "the database CHANGED: a write bypassed the approval gate");
}

export { fingerprint };
