import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findApplications, getApplicationById } from "../../repos/applications.js";
import { listEvents } from "../../repos/events.js";
import { applicationLine, isoDay, text } from "../format.js";

export function registerGetApplication(server: McpServer) {
  server.registerTool(
    "get_application",
    {
      title: "Get Job Application",
      description:
        "Show one job application in full, including its status history. " +
        "Pass the id if you have it (from list_applications), otherwise the company name and, if known, the role. " +
        "If several applications match, returns the list so you can ask the user which one.",
      inputSchema: {
        id: z.uuid().optional().describe("Application id"),
        company: z.string().trim().min(1).optional().describe("Part of the company name"),
        role: z.string().trim().min(1).optional().describe("Part of the role title"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, company, role }) => {
      let app;
      if (id) {
        app = await getApplicationById(id);
        if (!app) return text(`No application with id ${id}.`, true);
      } else if (company) {
        const matches = await findApplications(company, role);
        if (matches.length === 0) {
          return text(`No application found for ${company}${role ? ` / ${role}` : ""}.`, true);
        }
        if (matches.length > 1) {
          return text(
            `${matches.length} applications match; ask the user which one, then call again with its id:\n` +
              matches.map(applicationLine).join("\n"),
          );
        }
        app = matches[0]!;
      } else {
        return text("Give either an id or a company name.", true);
      }

      const events = await listEvents(app.id);
      const history = events.map(
        (e) =>
          `- ${isoDay(e.occurred_at)}: ${e.from_status ?? "(created)"} -> ${e.to_status}` +
          (e.note ? ` (${e.note})` : ""),
      );
      return text(
        [
          applicationLine(app),
          app.url && `URL: ${app.url}`,
          app.notes && `Notes: ${app.notes}`,
          "Status history:",
          ...history,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );
}