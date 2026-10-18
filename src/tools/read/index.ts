import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListApplications } from "./list-applications.js";
import { registerGetApplication } from "./get-application.js";
import { registerFindStaleApplications } from "./find-stale-applications.js";
import { registerGetPipelineSummary } from "./get-pipeline-summary.js";

export function registerReadTools(server: McpServer) {
  registerListApplications(server);
  registerGetApplication(server);
  registerFindStaleApplications(server);
  registerGetPipelineSummary(server);
}