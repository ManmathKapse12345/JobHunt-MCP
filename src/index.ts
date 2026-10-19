// stdio entry point. Claude Desktop's config runs dist/index.js: it starts this as a
// child process and talks JSON-RPC over stdin/stdout. (src/http.ts is the deployed one.)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startApprovalServer } from "./hitl/approval-server.js";
import { createServer } from "./server.js";

const server = createServer();

// The local page that approval links point to (used when the client can't elicit).
await startApprovalServer();

await server.connect(new StdioServerTransport());

// Log to STDERR only. stdout belongs to the protocol.
console.error("jobhunt-mcp running on stdio");
