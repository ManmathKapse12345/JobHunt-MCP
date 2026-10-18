import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findStaleApplications, getPipelineSummary } from "../repos/applications.js";
import { isoDay, pipelineText } from "../tools/format.js";
import { PIPELINE_URI } from "../resources/pipeline.js";

// Prompt arguments are always strings on the wire (the spec has no numbers), so "days"
// is a string of digits that we convert ourselves.
const Days = z
  .string()
  .trim()
  .regex(/^\d+$/, "a whole number of days, e.g. 7")
  .transform(Number)
  .pipe(z.number().int().min(1).max(365));

// A prompt the user picks (e.g. from a "/" menu). Unlike a tool, it runs before the model
// sees anything: it fetches the data now and returns ready-made messages.
export function registerWeeklyFollowupsPrompt(server: McpServer) {
  server.registerPrompt(
    "weekly_followups",
    {
      title: "Weekly Follow-ups",
      description:
        "Plan this week's follow-ups: lists open applications that have gone quiet and asks " +
        "Claude to draft a short follow-up message for each.",
      argsSchema: {
        days: Days.optional().describe("Quiet for at least this many days (default 7)"),
        tone: z.enum(["friendly", "formal"]).optional().describe("Tone of the drafts (default friendly)"),
      },
    },
    async ({ days = 7, tone = "friendly" }) => {
      const [stale, summary] = await Promise.all([findStaleApplications(days), getPipelineSummary()]);

      const list =
        stale.length === 0
          ? `No open application has been quiet for ${days}+ days.`
          : stale
              .map(
                (a) =>
                  `- ${a.role} at ${a.company} | ${a.status} | quiet ${a.days_quiet} days ` +
                  `(last change ${isoDay(a.last_change)})` +
                  (a.notes ? ` | notes: ${a.notes}` : "") +
                  ` (id ${a.id})`,
              )
              .join("\n");

      const instructions =
        stale.length === 0
          ? "Tell me that, and suggest one or two new companies or roles worth adding to my wishlist."
          : [
              `For each application, draft a short ${tone} follow-up message (3-5 sentences) to the recruiter or hiring team.`,
              "Use what the notes say (recruiter names, interview dates) when they help.",
              "Then give me a checklist ordered by how long each has been quiet.",
              "If one looks dead (quiet for over 30 days), suggest marking it rejected with update_application_status; " +
                "that change still needs my approval, so only propose it.",
            ].join("\n");

      return {
        description: `Follow-ups for applications quiet ${days}+ days`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Help me with this week's job-search follow-ups.\n\nApplications quiet for ${days}+ days:\n${list}\n\n${instructions}`,
            },
          },
          // The overall pipeline, attached as an embedded resource for context.
          {
            role: "user",
            content: {
              type: "resource",
              resource: { uri: PIPELINE_URI, mimeType: "text/plain", text: pipelineText(summary) },
            },
          },
        ],
      };
    },
  );
}
