import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guardHandlers } from "./guard.js";
import { log } from "./log.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerApprovalApp } from "./tools/approval-app.js";
import { type GmailDeps, registerGmailTools } from "./tools/gmail.js";
import { registerReadTools } from "./tools/read/index.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerWriteTools } from "./tools/write/index.js";

// One McpServer per connection: stdio has exactly one, HTTP makes one per session.
// They all share the database pools, which are module-level.
// gmail: where the Gmail tools read email from (tests pass a fake inbox).
// approvalPanel: offer the in-chat approval panel (tools/approval-app.ts). Local stdio only:
// the deployed server makes you sign in to approve, which a panel can't do.
export function createServer(opts: { gmail?: GmailDeps; approvalPanel?: boolean } = {}): McpServer {
  // name/version are sent to the client during `initialize`.
  const server = new McpServer({
    name: "jobhunt-mcp",
    version: "0.5.0",
  });

  // First: every tool, resource and prompt registered below gets error handling and logging.
  guardHandlers(server);

  // Which client connected and what it can do: whether approvals can be asked in the chat
  // (elicitation) or need a link is decided from this.
  server.server.oninitialized = () => {
    const capabilities = server.server.getClientCapabilities();
    log.info(
      { client: server.server.getClientVersion(), capabilities, inChatApproval: Boolean(capabilities?.elicitation?.form) },
      "client connected",
    );
  };

  // Registering resources and prompts also advertises those capabilities in `initialize`.
  registerUtilityTools(server);
  registerReadTools(server);
  registerWriteTools(server);
  registerGmailTools(server, opts.gmail);
  if (opts.approvalPanel) registerApprovalApp(server);
  registerResources(server);
  registerPrompts(server);
  return server;
}
