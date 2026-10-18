import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerApplicationResource } from "./application.js";
import { registerPipelineResource } from "./pipeline.js";

// Read-only context the user can attach. Uses the same read repos (mcp_reader) as the read tools.
export function registerResources(server: McpServer) {
  registerPipelineResource(server);
  registerApplicationResource(server);
}
