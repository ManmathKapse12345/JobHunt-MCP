// The Express app behind the deployed server. src/http.ts reads the environment and starts
// it; tests build one directly with their own options.
//
//   POST   /mcp            JSON-RPC from the client (bearer token required)
//   GET    /mcp            optional server -> client event stream for a session
//   DELETE /mcp            client ends its session
//   GET    /healthz        for Render's health check (no auth, no database, no rate limit)
//   /approve/:id, /login, /logout   the approval page, behind its own sign-in
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createApprovalHandler, isApprovalPath, page, send, sendFailure } from "./hitl/approval-page.js";
import { secretEquals } from "./hitl/token.js";
import { log } from "./log.js";
import { createServer } from "./server.js";

export interface HttpAppOptions {
  mcpAuthToken: string;
  adminToken: string;
  // Origins the approval page accepts (Host / Origin checks).
  approvalOrigins: string[];
  // Behind exactly one proxy (Render): take the client IP from X-Forwarded-For.
  trustProxy: boolean;
  // Requests per minute per client IP, for everything except /healthz.
  rateLimitPerMinute: number;
}

const hlog = log.child({ component: "http" });

export function createHttpApp(opts: HttpAppOptions) {
  const app = express();
  app.disable("x-powered-by");
  // On Render, requests arrive through one proxy that adds X-Forwarded-For. Trusting exactly
  // one hop makes req.ip the real client (used for rate limits). Locally there is no
  // proxy, and trusting the header would let anyone fake their IP.
  if (opts.trustProxy) app.set("trust proxy", 1);

  // Before any auth, and without touching the database: a Supabase hiccup should not make
  // Render restart a healthy server. Not rate-limited: Render polls it.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // One log line per request. The path only, never the query string: approval links
  // carry their secret token there.
  app.use((req, res, next) => {
    const started = performance.now();
    res.on("finish", () => {
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      hlog[level](
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Math.round(performance.now() - started),
          ip: req.ip,
          sessionId: req.header("mcp-session-id"),
        },
        "request",
      );
    });
    next();
  });

  // ---------- rate limit ----------
  // Per client IP, before auth: a flood of bad-token requests is cut off as early as a good
  // one. Fixed one-minute window, in memory (one instance). Answers 429 with Retry-After
  // and the standard RateLimit headers, so a well-behaved client knows when to retry.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: opts.rateLimitPerMinute,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (req, res) => {
        hlog.warn({ ip: req.ip, path: req.path, limit: opts.rateLimitPerMinute }, "rate limited");
        if (req.path === "/mcp") return jsonRpcError(res, 429, "Too many requests. Wait for the Retry-After seconds, then retry.");
        send(res, 429, page("Too many requests", "<p>Slow down: wait a minute, then reload.</p>"));
      },
    }),
  );

  // ---------- bearer auth for /mcp ----------
  // Every request must carry the shared secret. Rejected before any MCP code runs.
  // (The MCP spec's full answer is OAuth 2.1; one static token is enough for a personal server.)
  function requireBearer(req: Request, res: Response, next: NextFunction) {
    const m = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "");
    if (m && secretEquals(m[1]!, opts.mcpAuthToken)) return next();
    res.set("WWW-Authenticate", 'Bearer realm="jobhunt-mcp"');
    jsonRpcError(res, 401, "Unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>");
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
        hlog.info({ sessionId: id, open: sessions.size }, "session opened");
      },
    });
    transport.onclose = () => {
      if (transport.sessionId && sessions.delete(transport.sessionId)) {
        hlog.info({ sessionId: transport.sessionId, open: sessions.size }, "session closed");
      }
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

  const idleSweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const s of sessions.values()) if (s.lastSeen < cutoff) void s.transport.close();
  }, 5 * 60_000);
  idleSweep.unref();

  // ---------- approval page ----------

  const approvalPage = createApprovalHandler({ origins: opts.approvalOrigins, adminToken: opts.adminToken });
  app.use((req, res, next) => {
    if (!isApprovalPath(req.path)) return next();
    approvalPage(req, res).catch((err) => sendFailure(res, err));
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send("jobhunt-mcp: MCP endpoint at /mcp (Streamable HTTP, bearer token required).\n");
  });

  // Last: log unexpected errors without sending stack traces to the client.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    hlog.error({ err, method: req.method, path: req.path }, "unexpected error");
    if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
  });

  return {
    app,
    sessionCount: () => sessions.size,
    async closeSessions() {
      clearInterval(idleSweep);
      await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()));
    },
  };
}

function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}
