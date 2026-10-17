// Two separate processes write to the same database at the same time.
// Run from the project root after `npm run build`:  npx tsx scripts/two-writers.ts
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PER_WRITER = 200;
const dir = await mkdtemp(path.join(tmpdir(), "jobhunt-2w-"));
const dbPath = path.join(dir, "jobhunt.db");
const startAt = Date.now() + 1000; // both writers start at exactly this moment

// The code each child process runs. It uses the BUILT store, like the real server does.
const writerCode = `
  const { addApplication } = await import("./dist/store.js");
  const [tag, startAt, count] = process.argv.slice(1);
  while (Date.now() < Number(startAt)) {}          // wait for the shared start time
  let sharedResult = "won";
  try {
    await addApplication({ company: "Shared Co", role: "SDE", status: "applied" });
  } catch (e) {
    sharedResult = e.name;
  }
  for (let i = 0; i < Number(count); i++) {
    await addApplication({ company: tag + " Corp " + i, role: "SDE", status: "applied" });
  }
  console.log("writer " + tag + ": Shared Co -> " + sharedResult);
`;

function runWriter(tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", writerCode, tag, String(startAt), String(PER_WRITER)],
      { env: { ...process.env, JOBHUNT_DATA_PATH: dbPath }, stdio: "inherit" },
    );
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`writer ${tag} exited with code ${code}`)),
    );
  });
}

try {
  await Promise.all([runWriter("A"), runWriter("B")]);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const { n } = db.prepare("SELECT count(*) AS n FROM applications").get() as { n: number };
  const shared = db
    .prepare("SELECT count(*) AS n FROM applications WHERE company = 'Shared Co'")
    .get() as { n: number };
  db.close();

  assert.equal(n, PER_WRITER * 2 + 1, "every write from both processes must be saved");
  assert.equal(shared.n, 1, "Shared Co must be saved exactly once");
  console.log(`✅ ${n} rows (${PER_WRITER} + ${PER_WRITER} + 1 shared), no lost writes, no duplicate`);
} finally {
  await rm(dir, { recursive: true, force: true });
}