import path from "node:path";
import { readFileSync } from "node:fs";
import pg from "pg";
import { env, projectRoot } from "../config.js";
import { log } from "../log.js";

// Return DATE columns as "YYYY-MM-DD" strings. By default pg turns them into
// JS Dates at local midnight, which shifts the day when printed as UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

// A pool keeps a few connections open and reuses them. One per database role.
export function makePool(connectionString: string, label: string): pg.Pool {
  // A Postgres on this machine (for local testing) has no TLS; anything else must use it.
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname);
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    // If the network drops mid-query, give up instead of leaving the tool call hanging.
    query_timeout: 15_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true, // don't keep the process alive after Claude disconnects
    // Encrypt AND verify we are really talking to Supabase, using its CA certificate.
    ssl: isLocal
      ? false
      : { ca: readFileSync(path.join(projectRoot, "certs", "supabase-ca.crt"), "utf8") },
  });
  // An idle connection can drop (network blip, Supabase restart). Without a listener
  // that error would crash the server.
  pool.on("error", (err) => log.warn({ component: "db", pool: label, err }, "idle connection error"));
  return pool;
}

// The postgres role. Only write tools (after approval) and the approval page use it.
export const writePool = makePool(env.DATABASE_URL, "write");

// The SELECT-only mcp_reader role, for read tools, resources and prompts.
// Without DATABASE_URL_READER, reads share the write pool: it works, but without least privilege.
export const readerConfigured = env.DATABASE_URL_READER !== undefined;
if (!readerConfigured) {
  log.warn(
    { component: "db" },
    "DATABASE_URL_READER is not set, so read tools connect with the full DATABASE_URL role. " +
      "Run supabase/migrations/003_mcp_reader.sql and set it in .env.",
  );
}
export const readPool = env.DATABASE_URL_READER
  ? makePool(env.DATABASE_URL_READER, "read")
  : writePool;

// Anything that can run a query: a pool, or one client inside a transaction.
export type Db = pg.Pool | pg.PoolClient;

// For scripts that exit when done.
export async function closePools(): Promise<void> {
  await Promise.all([writePool.end(), readPool !== writePool && readPool.end()]);
}
