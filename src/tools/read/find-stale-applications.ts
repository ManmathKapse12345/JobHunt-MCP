import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findStaleApplications, OPEN_STATUSES } from "../../repos/applications.js";
import { isoDay, text } from "../format.js";

export function registerFindStaleApplications(server: McpServer) {
  server.registerTool(
    "find_stale_applications",
    {
      title: "Find Stale Applications",
      description:
        "Find open applications (status applied, oa or interview) whose status has not changed for N days. " +
        "Use this when the user asks which applications are stale, have gone quiet, or need a follow-up. " +
        "Default is 14 days.",
      inputSchema: {
        days: z.number().int().min(1).max(365).default(14).describe("Quiet for at least this many days"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ days }) => {
      const rows = await findStaleApplications(days);
      if (rows.length === 0) {
        return text(`Nothing stale: every open application (${OPEN_STATUSES.join(", ")}) changed within ${days} days.`);
      }
      const lines = rows.map(
        (a) =>
          `- ${a.role} at ${a.company} | ${a.status} | no change for ${a.days_quiet} days ` +
          `(since ${isoDay(a.last_change)}) (id ${a.id})`,
      );
      return text(`${rows.length} application(s) quiet for ${days}+ days:\n${lines.join("\n")}`);
    },
  );
}