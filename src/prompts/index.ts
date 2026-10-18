import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWeeklyFollowupsPrompt } from "./weekly-followups.js";

// Reusable message templates the user picks. They read through mcp_reader, like the read tools.
export function registerPrompts(server: McpServer) {
  registerWeeklyFollowupsPrompt(server);
}
