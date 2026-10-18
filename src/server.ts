import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLegacyTools } from "./tools/legacy.js";
import { registerReadTools } from "./tools/read/index.js";

// name/version are sent to the client during `initialize`.
const server = new McpServer({
  name: "jobhunt-mcp",
  version: "0.2.0",
});

registerLegacyTools(server);
registerReadTools(server);

// Claude Desktop launches this as a child process and talks JSON-RPC over stdin/stdout.
const transport = new StdioServerTransport();
await server.connect(transport);

// Log to STDERR only. stdout belongs to the protocol.
console.error("jobhunt-mcp running on stdio");