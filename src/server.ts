import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerReadTools } from "./tools/read/index.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerWriteTools } from "./tools/write/index.js";

// One McpServer per connection: stdio has exactly one, HTTP makes one per session.
// They all share the database pools, which are module-level.
export function createServer(): McpServer {
  // name/version are sent to the client during `initialize`.
  const server = new McpServer({
    name: "jobhunt-mcp",
    version: "0.5.0",
  });

  // Registering resources and prompts also advertises those capabilities in `initialize`.
  registerUtilityTools(server);
  registerReadTools(server);
  registerWriteTools(server);
  registerResources(server);
  registerPrompts(server);
  return server;
}
