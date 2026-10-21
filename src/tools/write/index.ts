import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAddApplication } from "./add-application.js";
import { registerUpdateApplicationStatus } from "./update-application-status.js";
import { registerUpdateApplication } from "./update-application.js";
import { registerDeleteApplication } from "./delete-application.js";
import { registerProposeChanges } from "./propose-changes.js";

// Every write tool goes through requireApproval: nothing is saved until the user says yes.
export function registerWriteTools(server: McpServer) {
  registerAddApplication(server);
  registerUpdateApplicationStatus(server);
  registerUpdateApplication(server);
  registerDeleteApplication(server);
  registerProposeChanges(server);
}
