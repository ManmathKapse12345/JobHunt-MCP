// HTTP entry point: the deployed server (Render runs `node dist/http.js`).
// src/index.ts is the stdio one that Claude Desktop starts locally; both share createServer().
//
//   POST   /mcp            JSON-RPC from the client (bearer token required)
//   GET    /mcp            optional server -> client event stream for a session
//   DELETE /mcp            client ends its session
//   GET    /healthz        for Render's health check (no auth, no database)
//   /approve/:id, /login, /logout   the approval page, behind its own sign-in
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { env } from "./config.js";
import { closePools } from "./db/pool.js";
import { createApprovalHandler, isApprovalPath } from "./hitl/approval-page.js";
import { setApprovalBaseUrl } from "./hitl/links.js";
import { secretEquals } from "./hitl/token.js";
import { createServer } from "./server.js";

const { MCP_AUTH_TOKEN, APPROVAL_ADMIN_TOKEN } = env;
if (!MCP_AUTH_TOKEN || !APPROVAL_ADMIN_TOKEN) {
  console.error("HTTP mode needs MCP_AUTH_TOKEN and APPROVAL_ADMIN_TOKEN (see .env.example).");
  process.exit(1);
}

const publicUrl = (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, "");
const publicOrigin = new URL(publicUrl).origin;
const isLocal = ["localhost", "127.0.0.1"].includes(new URL(publicUrl).hostname);

const app = express();
app.disable("x-powered-by");
// On Render, requests arrive through one proxy that adds X-Forwarded-For. Trusting exactly
// one hop makes req.ip the real client (used to rate-limit sign-ins). Locally there is no
// proxy, and trusting the header would let anyone fake their IP.
if (env.RENDER_EXTERNAL_URL) app.set("trust proxy", 1);

// Before any auth, and without touching the database: a Supabase hiccup should not make
// Render restart a healthy server.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// ---------- bearer auth for /mcp ----------
// Every request must carry the shared secret. Rejected before any MCP code runs.
// (The MCP spec's full answer is OAuth 2.1; one static token is enough for a personal server.)
function requireBearer(req: Request, res: Response, next: NextFunction) {
  const m = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "");
  if (m && secretEquals(m[1]!, MCP_AUTH_TOKEN!)) return next();
  res.set("WWW-Authenticate", 'Bearer realm="jobhunt-mcp"');
  jsonRpcError(res, 401, "Unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>");
}

function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

// ---------- sessions ----------
// Streamable HTTP is many POSTs, not one connection. `initialize` creates a session: its id
// comes back in the Mcp-Session-Id header and the client sends it on every later request.
// Each session gets its own transport and McpServer, so elicitation (the approval question)
// reaches the right client. In memory: fine for one instance; a restart makes clients
// initialize again.

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}
const sessions = new Map<string, Session>();
const MAX_SESSIONS = 50;
const IDLE_MS = 60 * 60_000; // clients don't always send DELETE; drop sessions idle for an hour

app.post("/mcp", requireBearer, express.json({ limit: "1mb" }), async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  if (sessionId) {
    const session = sessions.get(sessionId);
    // 404 tells a spec-following client to start over with a new initialize.
    if (!session) return jsonRpcError(res, 404, "Unknown session. Initialize again.");
    session.lastSeen = Date.now();
    return session.transport.handleRequest(req, res, req.body);
  }

  if (!isInitializeRequest(req.body)) return jsonRpcError(res, 400, "No Mcp-Session-Id: send initialize first.");
  if (sessions.size >= MAX_SESSIONS) return jsonRpcError(res, 503, "Too many open sessions. Try again later.");

  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, lastSeen: Date.now() });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await createServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// GET opens the optional server -> client stream; DELETE ends the session.
async function existingSession(req: Request, res: Response) {
  const session = sessions.get(req.header("mcp-session-id") ?? "");
  if (!session) return jsonRpcError(res, 404, "Unknown session. Initialize again.");
  session.lastSeen = Date.now();
  await session.transport.handleRequest(req, res);
}
app.get("/mcp", requireBearer, existingSession);
app.delete("/mcp", requireBearer, existingSession);

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const s of sessions.values()) if (s.lastSeen < cutoff) void s.transport.close();
}, 5 * 60_000).unref();

// ---------- approval page ----------

setApprovalBaseUrl(publicUrl);
const approvalPage = createApprovalHandler({
  origins: isLocal ? [publicOrigin, `http://127.0.0.1:${env.PORT}`, `http://localhost:${env.PORT}`] : [publicOrigin],
  adminToken: APPROVAL_ADMIN_TOKEN,
});
app.use((req, res, next) => {
  if (!isApprovalPath(req.path)) return next();
  approvalPage(req, res).catch(next);
});

app.get("/", (_req, res) => {
  res.type("text/plain").send("jobhunt-mcp: MCP endpoint at /mcp (Streamable HTTP, bearer token required).\n");
});

// Last: log unexpected errors without sending stack traces to the client.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("http: unexpected error", err);
  if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
});

// ---------- start / stop ----------

const httpServer = app.listen(env.PORT, env.HOST, () => {
  console.error(`jobhunt-mcp (HTTP) listening on ${env.HOST}:${env.PORT}, public URL ${publicUrl}`);
});

// Render sends SIGTERM before replacing the server on each deploy.
async function shutdown(signal: string) {
  console.error(`${signal}: closing ${sessions.size} session(s)`);
  await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()));
  httpServer.close();
  await closePools();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
