// Runs once before all test files, in the main Vitest process.
import pg from "pg";
import { assertLocalDatabase, TEST_ENV } from "./env.js";

export default async function globalSetup() {
  const env = { ...process.env, ...TEST_ENV };
  assertLocalDatabase(env);

  // Fail fast with a useful message instead of 50 connection errors.
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    const { rows } = await client.query("select 1 from pg_roles where rolname = 'mcp_reader'");
    if (rows.length === 0) throw new Error("the mcp_reader role is missing (migrations did not run)");
  } catch (err) {
    // A refused connection has an empty message and only a code (ECONNREFUSED).
    const reason = (err as Error).message || (err as { code?: string }).code || "connection failed";
    throw new Error(
      `Test database not ready at ${new URL(env.DATABASE_URL).host}: ${reason}\n` +
        "Start it with:  npm run db:up",
    );
  } finally {
    await client.end().catch(() => {});
  }
}
