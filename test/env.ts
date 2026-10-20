// The databases the tests use: the docker-compose Postgres (docker-compose.yml).
// Shared by vitest.config.ts (sets them for the tests) and the global setup (checks them).
export const TEST_ENV = {
  DATABASE_URL: "postgresql://postgres@localhost:54329/jobhunt_test",
  DATABASE_URL_READER: "postgresql://mcp_reader@localhost:54329/jobhunt_test",
  // Keep test output readable; LOG_LEVEL=debug npm test shows the server's logs.
  LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Tests empty every table before each test. Refuse anything that isn't this computer,
// so a stray DATABASE_URL can never wipe the real tracker on Supabase.
export function assertLocalDatabase(env: NodeJS.ProcessEnv = process.env) {
  for (const key of ["DATABASE_URL", "DATABASE_URL_READER"] as const) {
    const url = env[key];
    if (!url || !LOCAL_HOSTS.has(new URL(url).hostname)) {
      throw new Error(`Refusing to run tests: ${key} must point at a local database, got ${url ? new URL(url).host : "nothing"}.`);
    }
  }
}
