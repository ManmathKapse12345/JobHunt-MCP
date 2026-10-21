// stdio entry point. Claude Desktop's config runs dist/index.js: it starts this as a
// child process and talks JSON-RPC over stdin/stdout. (src/http.ts is the deployed one.)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { installCrashHandlers } from "./guard.js";
import { startApprovalServer } from "./hitl/approval-server.js";
import { startExpirySweeper } from "./hitl/expiry-sweeper.js";
import { log } from "./log.js";
import { createServer } from "./server.js";

installCrashHandlers();

// The approval panel too: clients that show MCP Apps (Claude Desktop) approve in the chat.
const server = createServer({ approvalPanel: true });

// The local page that approval links point to (used when the client can't elicit).
await startApprovalServer();
startExpirySweeper();

await server.connect(new StdioServerTransport());

// Log to STDERR only (log.ts does). stdout belongs to the protocol.
log.info({ transport: "stdio" }, "jobhunt-mcp running");
