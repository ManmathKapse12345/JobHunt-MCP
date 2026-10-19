// Turn a promptfoo results file into a per-bucket pass-rate table (Markdown).
//   node evals/summarize.mjs evals/results/latest.json [evals/results/before.md]
import { readFileSync, writeFileSync } from "node:fs";

const [input = "evals/results/latest.json", output] = process.argv.slice(2);
const data = JSON.parse(readFileSync(input, "utf8"));
const rows = data.results?.results ?? [];

const buckets = new Map();
const failures = [];
for (const r of rows) {
  const bucket = r.testCase?.metadata?.bucket ?? r.metadata?.bucket ?? "unbucketed";
  const b = buckets.get(bucket) ?? { pass: 0, total: 0 };
  b.total++;
  if (r.success) b.pass++;
  else {
    const reasons = (r.gradingResult?.componentResults ?? [])
      .filter((c) => !c.pass)
      .map((c) => c.reason)
      .join(" / ");
    failures.push(`- **${r.testCase?.description ?? "?"}** (${bucket}): ${reasons || r.error || "failed"}`);
  }
  buckets.set(bucket, b);
}

const pct = (p, t) => (t ? `${Math.round((p / t) * 100)}%` : "-");
const total = [...buckets.values()].reduce((a, b) => ({ pass: a.pass + b.pass, total: a.total + b.total }), { pass: 0, total: 0 });
const lines = [
  `| Bucket | Passed | Rate |`,
  `|---|---|---|`,
  ...[...buckets.entries()].sort().map(([name, b]) => `| ${name} | ${b.pass}/${b.total} | ${pct(b.pass, b.total)} |`),
  `| **Total** | **${total.pass}/${total.total}** | **${pct(total.pass, total.total)}** |`,
  "",
  failures.length ? `Failures:\n${failures.join("\n")}` : "No failures.",
  "",
];
const md = lines.join("\n");
console.log(md);
if (output) writeFileSync(output, md);
