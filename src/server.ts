import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guardHandlers } from "./guard.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { type GmailDeps, registerGmailTools } from "./tools/gmail.js";
import { registerReadTools } from "./tools/read/index.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerWriteTools } from "./tools/write/index.js";

// One McpServer per connection: stdio has exactly one, HTTP makes one per session.
// They all share the database pools, which are module-level.
// gmail: where the Gmail tools read email from (tests pass a fake inbox).
export function createServer(opts: { gmail?: GmailDeps } = {}): McpServer {
  // name/version are sent to the client during `initialize`.
  const server = new McpServer({
    name: "jobhunt-mcp",
    version: "0.5.0",
  });

  // First: every tool, resource and prompt registered below gets error handling and logging.
  guardHandlers(server);

  // Registering resources and prompts also advertises those capabilities in `initialize`.
  registerUtilityTools(server);
  registerReadTools(server);
  registerWriteTools(server);
  registerGmailTools(server, opts.gmail);
  registerResources(server);
  registerPrompts(server);
  return server;
}
