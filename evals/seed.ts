// Empty the local test database and load evals/fixture.ts. Run before every eval:
//   npm run eval   (does this, then promptfoo)
// Uses the docker-compose database only (same guard as the Vitest suite).
import { TEST_ENV } from "../test/env.js";

// Set before src/config.ts is imported, so .env's Supabase URLs are never used.
Object.assign(process.env, TEST_ENV);

const { assertLocalDatabase } = await import("../test/env.js");
assertLocalDatabase();
const { resetDb, seedApplication } = await import("../test/helpers/db.js");
const { closePools } = await import("../src/db/pool.js");
const { FIXTURE } = await import("./fixture.js");

await resetDb();
for (const app of FIXTURE) await seedApplication(app);

// Fingerprint of the seeded data. The dbUnchanged assertion compares against it after
// every case: any difference means a write got past the approval gate.
const { fingerprint } = await import("./assertions.mjs");
const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./.baseline.json", import.meta.url), JSON.stringify({ fingerprint: await fingerprint() }) + "\n");

console.log(`seeded ${FIXTURE.length} applications into ${new URL(TEST_ENV.DATABASE_URL).host}`);
await closePools();
process.exit(0); // assertions.mjs keeps its own small pool open
