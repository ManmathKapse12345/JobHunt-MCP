// Field-by-field accuracy of the email extractor against labelled cases.
//   npm run eval:extract              (needs ANTHROPIC_API_KEY; EXTRACT_MODEL picks the model)
// Writes evals/results/extract-latest.json and prints a Markdown table.
//
// Scoring, per field: right if it equals the label. Roles compare case-insensitively and
// ignore punctuation; dates must be the same instant within a minute. A value where the
// label is null (a guess) is wrong, and so is a null where the label has a value.
import { mkdirSync, writeFileSync } from "node:fs";
import { env } from "../../src/config.js";
import { createClaudeExtractor, type Extraction } from "../../src/google/extract.js";
import { CASES } from "./cases.js";

if (!env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY (in .env) to run the extraction eval.");
  process.exit(1);
}

const extractor = createClaudeExtractor({ apiKey: env.ANTHROPIC_API_KEY, model: env.EXTRACT_MODEL, timeZone: "Asia/Kolkata" });
const FIELDS = ["role", "kind", "eventAt", "deadlineAt"] as const;
type Field = (typeof FIELDS)[number];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function same(field: Field, got: Extraction[Field], want: string | null): boolean {
  if (want === null || got === null) return want === null && got === null;
  if (field === "eventAt" || field === "deadlineAt") return Math.abs((got as Date).getTime() - new Date(want).getTime()) < 60_000;
  return norm(String(got)) === norm(want);
}

const score = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<Field, number>;
const results = [];
let allRight = 0;
for (const c of CASES) {
  const got = await extractor.extract({ ...c.email, receivedAt: new Date(c.email.receivedAt) });
  const wrong = FIELDS.filter((f) => !same(f, got[f], c.expect[f]));
  for (const f of FIELDS) if (!wrong.includes(f)) score[f]++;
  if (wrong.length === 0) allRight++;
  results.push({ name: c.name, pass: wrong.length === 0, wrong, got, expect: c.expect });
  console.error(`${wrong.length === 0 ? "PASS" : "FAIL"}  ${c.name}${wrong.length ? `  (${wrong.join(", ")})` : ""}`);
}

const pct = (n: number) => `${Math.round((100 * n) / CASES.length)}%`;
const table = [
  `Extraction eval: ${extractor.model}, ${CASES.length} emails`,
  "",
  "| Field | Correct |",
  "|---|---|",
  ...FIELDS.map((f) => `| ${f} | ${score[f]}/${CASES.length} (${pct(score[f])}) |`),
  `| **all fields right** | **${allRight}/${CASES.length} (${pct(allRight)})** |`,
].join("\n");
console.log(`\n${table}`);

for (const r of results.filter((x) => !x.pass)) {
  console.log(`\n- ${r.name}: ${r.wrong.map((f) => `${f} = ${JSON.stringify(r.got[f])}, expected ${JSON.stringify(r.expect[f])}`).join("; ")}`);
}

mkdirSync("evals/results", { recursive: true });
writeFileSync(
  "evals/results/extract-latest.json",
  JSON.stringify({ model: extractor.model, at: new Date().toISOString(), score, allRight, total: CASES.length, results }, null, 2),
);
