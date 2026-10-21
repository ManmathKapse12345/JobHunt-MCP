// Import past applications from LinkedIn's data export.
//   npm run linkedin:import -- <path>   the unzipped export folder, or one "Job Applications.csv"
// Adds go through the approval page in batches (a checkbox each); rows already tracked are
// skipped. Only company, title, URL and date are read into the tracker.
// Uses the database in .env (your real tracker). Add --demo for the local Docker database.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

if (process.argv.includes("--demo")) {
  const { TEST_ENV } = await import("../test/env.js");
  Object.assign(process.env, TEST_ENV);
}
const { closePools } = await import("../src/db/pool.js");
const { listAllApplications } = await import("../src/repos/applications.js");
const { parseLinkedInApplications, proposeImport } = await import("../src/imports/linkedin.js");
const { approveInBrowser } = await import("./approve.js");

const target = process.argv.slice(2).find((a) => !a.startsWith("--"));

try {
  if (!target) {
    console.log(
      "Usage: npm run linkedin:import -- <path>\n\n" +
        "Get the file from LinkedIn: Settings -> Data privacy -> Get a copy of your data -> tick\n" +
        '"Job applications" -> Request archive. LinkedIn emails a download link (it can take a day).\n' +
        "Unzip it and pass the folder, or the Job Applications.csv inside it.",
    );
    process.exitCode = 1;
  } else {
    const files = csvFiles(path.resolve(target));
    if (files.length === 0) throw new Error(`No "Job Applications*.csv" found in ${target}.`);
    const rows = [];
    for (const f of files) {
      const { rows: r, problems } = parseLinkedInApplications(readFileSync(f, "utf8"));
      console.log(`${path.basename(f)}: ${r.length} application${r.length === 1 ? "" : "s"}${problems.length ? `, ${problems.length} rows skipped` : ""}`);
      for (const p of problems) console.log(`  ${p}`);
      rows.push(...r);
    }

    const { batches, alreadyTracked, duplicates, skipped } = await proposeImport(rows, await listAllApplications());
    console.log(
      `\n${alreadyTracked} already in your tracker, ${duplicates} listed twice in the export (the first is kept), ` +
        `${batches.reduce((n, b) => n + (b.payload as { items: unknown[] }).items.length, 0)} to add.`,
    );
    if (skipped.length) {
      console.log(`\nNot proposed (${skipped.length}):`);
      for (const s of skipped) console.log(`  ${s.what}: ${s.reason}`);
    }
    if (batches.length === 0) console.log("\nNothing to add.");
    for (const [i, batch] of batches.entries()) {
      console.log(`\n--- Batch ${i + 1} of ${batches.length} ---\n`);
      await approveInBrowser(batch);
    }
  }
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePools();
}

// One file, or every "Job Applications.csv" / "Job Applications_1.csv" under a folder.
function csvFiles(p: string): string[] {
  if (!statSync(p, { throwIfNoEntry: false })) throw new Error(`${p} doesn't exist.`);
  if (statSync(p).isFile()) return [p];
  return readdirSync(p, { recursive: true, encoding: "utf8" })
    .filter((f) => /^job applications(_\d+)?\.csv$/i.test(path.basename(f)))
    .map((f) => path.join(p, f))
    .sort();
}
