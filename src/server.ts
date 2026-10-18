import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startApprovalServer } from "./hitl/approval-server.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerReadTools } from "./tools/read/index.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerWriteTools } from "./tools/write/index.js";

// name/version are sent to the client during `initialize`.
const server = new McpServer({
  name: "jobhunt-mcp",
  version: "0.4.0",
});

// Registering resources and prompts also advertises those capabilities in `initialize`.
registerUtilityTools(server);
registerReadTools(server);
registerWriteTools(server);
registerResources(server);
registerPrompts(server);

// The local page that approval links point to (used when the client can't elicit).
await startApprovalServer();

// Claude Desktop launches this as a child process and talks JSON-RPC over stdin/stdout.
const transport = new StdioServerTransport();
await server.connect(transport);

// Log to STDERR only. stdout belongs to the protocol.
console.error("jobhunt-mcp running on stdio");
