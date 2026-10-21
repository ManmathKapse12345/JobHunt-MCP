// What promptfoo starts (over stdio) instead of dist/index.js.
//
// promptfoo loads .env (for GEMINI_API_KEY) and passes its environment to this
// process, so DATABASE_URL here would be your real Supabase tracker. Evals must only
// ever see the seeded test database, so this OVERWRITES both URLs before the server
// reads them (src/config.ts never overrides variables that are already set).
// Same database as the Vitest suite: test/env.ts. Start it with `npm run db:up`.
const TEST_DB = "localhost:54329/jobhunt_test";
process.env.DATABASE_URL = `postgresql://postgres@${TEST_DB}`;
process.env.DATABASE_URL_READER = `postgresql://mcp_reader@${TEST_DB}`;
// Any free port for the local approval page, so it never clashes with a server
// that Claude Desktop is running at the same time.
process.env.APPROVAL_PORT = "0";

for (const key of ["DATABASE_URL", "DATABASE_URL_READER"]) {
  const host = new URL(process.env[key]).hostname;
  if (host !== "localhost") {
    console.error(`evals/server.mjs: refusing to start, ${key} is not local (${host})`);
    process.exit(1);
  }
}

await import("../dist/index.js");
