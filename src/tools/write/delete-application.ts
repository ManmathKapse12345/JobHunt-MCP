import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prepareDelete } from "../../hitl/actions.js";
import { runWithApproval } from "./run-with-approval.js";

export function registerDeleteApplication(server: McpServer) {
  server.registerTool(
    "delete_application",
    {
      title: "Delete Job Application",
      description:
        "Remove an application the user no longer wants to track (e.g. added by mistake). " +
        "For a company that said no, use update_application_status with 'rejected' instead. " +
        "This is a soft delete: it disappears from every list, but its history is kept. " +
        "Needs the application id. The user must approve first: if the reply contains an " +
        "approval link, show it to the user.",
      inputSchema: {
        id: z.uuid().describe("Application id"),
        reason: z.string().trim().min(1).optional().describe("Why, e.g. 'duplicate entry'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input, extra) => runWithApproval(server, extra.requestId, () => prepareDelete(input)),
  );
}
