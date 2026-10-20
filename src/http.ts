// HTTP entry point: the deployed server (Render runs `node dist/http.js`).
// src/index.ts is the stdio one that Claude Desktop starts locally; both share createServer().
// The routes, auth and rate limit live in http-app.ts.
import { env } from "./config.js";
import { closePools } from "./db/pool.js";
import { installCrashHandlers } from "./guard.js";
import { startExpirySweeper } from "./hitl/expiry-sweeper.js";
import { setApprovalBaseUrl } from "./hitl/links.js";
import { createHttpApp } from "./http-app.js";
import { log } from "./log.js";

installCrashHandlers();

const { MCP_AUTH_TOKEN, APPROVAL_ADMIN_TOKEN } = env;
if (!MCP_AUTH_TOKEN || !APPROVAL_ADMIN_TOKEN) {
  log.fatal("HTTP mode needs MCP_AUTH_TOKEN and APPROVAL_ADMIN_TOKEN (see .env.example).");
  process.exit(1);
}

const publicUrl = (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, "");
const publicOrigin = new URL(publicUrl).origin;
const isLocal = ["localhost", "127.0.0.1"].includes(new URL(publicUrl).hostname);

setApprovalBaseUrl(publicUrl);
const { app, sessionCount, closeSessions } = createHttpApp({
  mcpAuthToken: MCP_AUTH_TOKEN,
  adminToken: APPROVAL_ADMIN_TOKEN,
  approvalOrigins: isLocal
    ? [publicOrigin, `http://127.0.0.1:${env.PORT}`, `http://localhost:${env.PORT}`]
    : [publicOrigin],
  trustProxy: env.RENDER_EXTERNAL_URL !== undefined,
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
});

const httpServer = app.listen(env.PORT, env.HOST, () => {
  log.info(
    { component: "http", host: env.HOST, port: env.PORT, publicUrl, rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE },
    "jobhunt-mcp (HTTP) listening",
  );
});
const stopSweeper = startExpirySweeper();

// Render sends SIGTERM before replacing the server on each deploy.
async function shutdown(signal: string) {
  log.info({ component: "http", signal, sessions: sessionCount() }, "shutting down");
  stopSweeper();
  await closeSessions();
  httpServer.close();
  await closePools();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
