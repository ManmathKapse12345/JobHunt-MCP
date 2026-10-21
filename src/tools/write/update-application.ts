import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isoDate } from "../../dates.js";
import { prepareUpdate } from "../../hitl/actions.js";
import { runWithApproval } from "./run-with-approval.js";

export function registerUpdateApplication(server: McpServer) {
  server.registerTool(
    "update_application",
    {
      title: "Edit Job Application",
      description:
        "Correct or add details on an existing application: role title, posting URL, source, notes " +
        "or applied date. Only pass the fields that change. To change the stage (applied, oa, ...) " +
        "use update_application_status instead. Needs the application id. " +
        "ONE application only: to edit two or more, use propose_changes (one approval with a checkbox each). " +
        "If more than one application could match what the user said, ask which one; never pick one yourself. " +
        "When exactly one application matches, use it without asking. " +
        "The user must approve first: if the reply contains an approval link, show it to the user.",
      inputSchema: {
        id: z.uuid().describe("Application id"),
        role: z.string().trim().min(1).optional().describe("New job title"),
        url: z.url().optional().describe("Link to the job posting"),
        source: z.string().trim().min(1).optional().describe("Where they found it"),
        notes: z.string().trim().min(1).optional().describe("Replaces the existing notes"),
        appliedOn: isoDate.optional().describe("Date they applied, YYYY-MM-DD"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input, extra) => runWithApproval(server, extra.requestId, () => prepareUpdate(input)),
  );
}
