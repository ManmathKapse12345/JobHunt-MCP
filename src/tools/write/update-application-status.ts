import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prepareStatusChange } from "../../hitl/actions.js";
import { APPLICATION_STATUSES } from "../../repos/applications.js";
import { runWithApproval } from "./run-with-approval.js";

export function registerUpdateApplicationStatus(server: McpServer) {
  server.registerTool(
    "update_application_status",
    {
      title: "Update Application Status",
      description:
        "Move an application to a new stage, e.g. applied -> oa when the user got an online assessment, " +
        "or -> rejected. Needs the application id (get it from list_applications or get_application). " +
        "If more than one application could match what the user said (e.g. two roles at one company, " +
        "or the same title at several companies), ask which one; never pick one yourself. " +
        "When exactly one application matches, use it without asking. " +
        "For several applications at once, list them and ask the user to confirm first. " +
        "The change is recorded in the application's history. " +
        "The user must approve first: if the reply contains an approval link, show it to the user.",
      inputSchema: {
        id: z.uuid().describe("Application id"),
        status: z.enum(APPLICATION_STATUSES).describe("The new stage"),
        note: z.string().trim().min(1).optional().describe("Why, e.g. 'OA link received by email'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input, extra) => runWithApproval(server, extra.requestId, () => prepareStatusChange(input)),
  );
}
