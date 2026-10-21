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
    // An error's first line only: the stack adds nothing to a summary.
    const error = r.error ? String(r.error).split("\n")[0].replace(/^Not run: /, "") : "";
    failures.push({ name: `**${r.testCase?.description ?? "?"}** (${bucket})`, why: reasons || error || "failed" });
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
  failures.length ? `Failures:\n${failureLines().join("\n")}` : "No failures.",
  "",
];
const md = lines.join("\n");

// The same reason for many cases (an API quota, a missing key) is listed once.
function failureLines() {
  const byWhy = Map.groupBy(failures, (f) => f.why);
  return [...byWhy].map(([why, fs]) =>
    fs.length > 3 ? `- ${fs.length} cases: ${why}` : fs.map((f) => `- ${f.name}: ${why}`).join("\n"),
  );
}
console.log(md);
if (output) writeFileSync(output, md);
