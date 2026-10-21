// Fill the local Docker database with a small, realistic tracker for trying the server
// (README "Connect in 2 minutes") and for recording the demo. No Supabase needed.
//   npm run demo:db     start the database and load this data (replaces what was there)
//   npm run demo:show   print the table, to watch an approved change land
// Uses the docker-compose database only (same guard as the tests and evals).
import { TEST_ENV } from "../test/env.js";

// Set before src/config.ts is imported, so .env's Supabase URLs are never used.
Object.assign(process.env, TEST_ENV);

const { assertLocalDatabase } = await import("../test/env.js");
assertLocalDatabase();
const { resetDb, seedApplication } = await import("../test/helpers/db.js");
const { closePools } = await import("../src/db/pool.js");

const DEMO = [
  { company: "Stripe", role: "Backend Engineer", status: "interview", appliedAt: "2026-09-22", source: "Referral", quietDays: 3, notes: "final round done Oct 17" },
  { company: "Google", role: "Software Engineer", status: "applied", appliedAt: "2026-09-28", source: "LinkedIn", quietDays: 18 },
  { company: "Microsoft", role: "SDE 1", status: "oa", appliedAt: "2026-10-06", source: "Careers page", quietDays: 5, notes: "OA on Codility, 2 problems" },
  { company: "Atlassian", role: "Graduate Engineer", status: "interview", appliedAt: "2026-09-30", source: "LinkedIn", quietDays: 2 },
  { company: "Razorpay", role: "Backend Engineer", status: "applied", appliedAt: "2026-10-04", source: "LinkedIn", quietDays: 12 },
  { company: "Flipkart", role: "SDE 1", status: "rejected", appliedAt: "2026-09-15", source: "Indeed", quietDays: 25 },
  { company: "Zomato", role: "Platform Engineer", status: "rejected", appliedAt: "2026-09-10", source: "Indeed", quietDays: 30 },
  { company: "Postman", role: "Developer Advocate", status: "applied", appliedAt: "2026-10-09", source: "Referral", quietDays: 9 },
  { company: "Notion", role: "Product Engineer", status: "wishlist" },
] as const;

await resetDb();
for (const app of DEMO) await seedApplication(app);
// A pretend Gmail account for the demo inbox (JOBHUNT_DEMO_INBOX=1): no real token behind it.
const { upsertGmailConnection } = await import("../src/repos/gmail-connections.js");
await upsertGmailConnection({ email: "demo@example.com", refreshTokenEnc: "demo", scopes: "demo" });
console.log(`loaded ${DEMO.length} demo applications and a demo inbox account into ${new URL(TEST_ENV.DATABASE_URL).host}`);
await closePools();
