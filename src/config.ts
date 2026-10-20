import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { log } from "./log.js";

// The project folder: one level up from this file (dist/ or src/).
// Claude Desktop does not start the server from here, so ".env" alone would not be found.
export const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const envPath = path.join(projectRoot, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const PostgresUrl = z
  .url()
  .refine((u) => /^postgres(ql)?:\/\//.test(u), "must start with postgresql://");

const EnvSchema = z.object({
  // The postgres role: used by write tools (behind approval) and the approval page.
  DATABASE_URL: PostgresUrl,
  // The SELECT-only mcp_reader role (supabase/migrations/003_mcp_reader.sql): used by
  // read tools, resources and prompts. Optional; without it reads fall back to DATABASE_URL.
  DATABASE_URL_READER: PostgresUrl.optional(),
  // Port of the local approval page (http://127.0.0.1:<port>/approve/...). 0 = pick a free one.
  APPROVAL_PORT: z.coerce.number().int().min(0).max(65535).default(4848),

  // ----- HTTP mode only (src/http.ts); src/http.ts refuses to start without the tokens -----
  // Clients send it as "Authorization: Bearer <token>" on every /mcp request.
  MCP_AUTH_TOKEN: z.string().min(32, "use at least 32 random characters").optional(),
  // The approval page's sign-in password. Only you know it; the model never sees it.
  APPROVAL_ADMIN_TOKEN: z.string().min(16, "use at least 16 random characters").optional(),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000), // Render sets this
  HOST: z.string().default("0.0.0.0"),
  // Where people reach the server, used to build approval links and check Host/Origin.
  // Render sets RENDER_EXTERNAL_URL itself; locally it defaults to http://localhost:<PORT>.
  PUBLIC_URL: z.url().optional(),
  RENDER_EXTERNAL_URL: z.url().optional(),
  // Requests per minute one client IP may send to the HTTP server (/mcp and the approval page).
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  log.fatal({ envFile: envPath, problems: z.prettifyError(parsed.error) }, "invalid environment");
  process.exit(1);
}

export const env = parsed.data;
log.level = env.LOG_LEVEL;