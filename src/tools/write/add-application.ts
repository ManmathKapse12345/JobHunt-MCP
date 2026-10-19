import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isoDate } from "../../dates.js";
import { prepareAdd } from "../../hitl/actions.js";
import { APPLICATION_STATUSES } from "../../repos/applications.js";
import { runWithApproval } from "./run-with-approval.js";

export function registerAddApplication(server: McpServer) {
  server.registerTool(
    "add_application",
    {
      title: "Add Job Application",
      description:
        "Save a new job application to the user's tracker. " +
        "Call this when the user says they applied to a job, or wants to track one they plan to apply to. " +
        "Only include details the user actually gave; never invent a URL, date, or notes. " +
        "If the company or role is unclear, ask the user before calling. " +
        "The user must approve before anything is saved: if the reply contains an approval link, " +
        "show it to the user. Fails if the same company and role is already tracked; " +
        "to change an existing application use update_application or update_application_status.",
      inputSchema: {
        company: z.string().trim().min(1).describe("Company name, e.g. Stripe"),
        role: z.string().trim().min(1).describe("Job title, e.g. Backend Engineer"),
        status: z
          .enum(APPLICATION_STATUSES)
          .default("applied")
          .describe("Current stage. Use 'wishlist' if they have not applied yet."),
        appliedOn: isoDate.optional().describe("Date they applied, YYYY-MM-DD. Omit if they applied today."),
        url: z.url().optional().describe("Link to the job posting, if the user gave one"),
        source: z.string().trim().min(1).optional().describe("Where they found it, e.g. LinkedIn, referral"),
        notes: z.string().trim().min(1).optional().describe("Anything else the user mentioned"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input, extra) => runWithApproval(server, extra.requestId, () => prepareAdd(input)),
  );
}
