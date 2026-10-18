import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APPLICATION_STATUSES, listApplications } from "../../repos/applications.js";
import { applicationLine, text } from "../format.js";

export function registerListApplications(server: McpServer) {
  server.registerTool(
    "list_applications",
    {
      title: "List Job Applications",
      description:
        "List the user's tracked job applications, newest first. " +
        "Use this to answer questions like 'show my rejected applications' or 'what did I apply to at TCS?'. " +
        "Filter by status and/or part of a company name. " +
        "For 'which applications are stale / have gone quiet', use find_stale_applications instead.",
      inputSchema: {
        status: z.enum(APPLICATION_STATUSES).optional().describe("Only this stage"),
        company: z.string().trim().min(1).optional().describe("Part of a company name, e.g. 'tata'"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max rows to return"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, company, limit }) => {
      const rows = await listApplications({ status, company, limit });
      if (rows.length === 0) return text("No applications match those filters.");
      return text(`${rows.length} application(s):\n${rows.map(applicationLine).join("\n")}`);
    },
  );
}