import path from "node:path";
import { readFileSync } from "node:fs";
import pg from "pg";
import { env, projectRoot } from "../config.js";

// Return DATE columns as "YYYY-MM-DD" strings. By default pg turns them into
// JS Dates at local midnight, which shifts the day when printed as UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

// A Postgres on this machine (for local testing) has no TLS; anything else must use it.
const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(env.DATABASE_URL).hostname);

// One pool for the whole process: it keeps a few connections open and reuses them.
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  allowExitOnIdle: true, // don't keep the process alive after Claude disconnects
  // Encrypt AND verify we are really talking to Supabase, using its CA certificate.
  ssl: isLocal
    ? false
    : { ca: readFileSync(path.join(projectRoot, "certs", "supabase-ca.crt"), "utf8") },
});

// Anything that can run a query: the pool itself, or one client inside a transaction.
export type Db = pg.Pool | pg.PoolClient;

// An idle connection can drop (network blip, Supabase restart). Without a listener
// that error would crash the server.
pool.on("error", (err) => console.error("pg pool: idle connection error", err));