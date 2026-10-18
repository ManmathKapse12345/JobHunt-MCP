import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// The project folder: one level up from this file (dist/ or src/).
// Claude Desktop does not start the server from here, so ".env" alone would not be found.
export const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const envPath = path.join(projectRoot, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const EnvSchema = z.object({
  DATABASE_URL: z
    .url()
    .refine((u) => /^postgres(ql)?:\/\//.test(u), "must start with postgresql://"),
  // Port of the local approval page (http://127.0.0.1:<port>/approve/...). 0 = pick a free one.
  APPROVAL_PORT: z.coerce.number().int().min(0).max(65535).default(4848),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // stderr, never stdout: stdout belongs to the MCP protocol.
  console.error(`Invalid environment (check ${envPath}):\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;