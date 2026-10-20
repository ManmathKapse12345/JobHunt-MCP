// Print the tracker. Run from the project root:
//   npm run show        your real tracker (DATABASE_URL in .env, e.g. Supabase)
//   npm run demo:show   the local demo database (npm run demo:db)
if (process.argv.includes("--demo")) {
  // Before src/config.ts is imported: already-set variables win over .env.
  const { TEST_ENV } = await import("../test/env.js");
  Object.assign(process.env, TEST_ENV);
}
const { closePools, readPool } = await import("../src/db/pool.js");

const { rows } = await readPool.query(
  `select c.name as company, a.role, a.status, a.applied_at, a.updated_at
     from applications a join companies c on c.id = a.company_id
    where a.deleted_at is null
    order by a.updated_at desc`,
);
console.table(rows.map((r) => ({ ...r, updated_at: r.updated_at.toISOString().slice(0, 19).replace("T", " ") })));
await closePools();
