// Print the tracker. Run from the project root:  npx tsx scripts/show.ts
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/jobhunt.db", { readOnly: true });
console.table(
  db.prepare("SELECT company, role, status, appliedOn FROM applications ORDER BY createdAt").all(),
);
db.close();