// stdio entry point. Claude Desktop's config runs dist/index.js: it starts this as a
// child process and talks JSON-RPC over stdin/stdout. (src/http.ts is the deployed one.)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { env } from "./config.js";
import { demoCalendar, demoExtractor, demoInbox } from "./google/demo-inbox.js";
import { installCrashHandlers } from "./guard.js";
import { useCalendar } from "./hitl/actions.js";
import { startApprovalServer } from "./hitl/approval-server.js";
import { startExpirySweeper } from "./hitl/expiry-sweeper.js";
import { log } from "./log.js";
import { createServer } from "./server.js";

installCrashHandlers();

// Demo inbox (docs/demo-script.md): made-up emails, never against a database off this computer.
const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(env.DATABASE_URL).hostname);
const demo = env.JOBHUNT_DEMO_INBOX && local;
if (env.JOBHUNT_DEMO_INBOX && !local) log.error("JOBHUNT_DEMO_INBOX ignored: it only runs against a local database");
if (demo) {
  useCalendar(async () => demoCalendar);
  log.info("demo inbox on: Gmail tools read made-up emails, calendar events stay in memory");
}

// The approval panel too: clients that show MCP Apps (Claude Desktop) approve in the chat.
const server = createServer({
  approvalPanel: true,
  gmail: demo ? { source: demoInbox, extractor: () => demoExtractor, calendar: async () => demoCalendar } : undefined,
});

// The local page that approval links point to (used when the client can't elicit).
await startApprovalServer();
startExpirySweeper();

await server.connect(new StdioServerTransport());

// Log to STDERR only (log.ts does). stdout belongs to the protocol.
log.info({ transport: "stdio" }, "jobhunt-mcp running");
