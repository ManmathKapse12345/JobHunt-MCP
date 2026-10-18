import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPipelineSummary } from "../../repos/applications.js";
import { text } from "../format.js";

export function registerGetPipelineSummary(server: McpServer) {
  server.registerTool(
    "get_pipeline_summary",
    {
      title: "Job Search Summary",
      description:
        "Overview of the user's whole job search: how many applications are at each stage, " +
        "where they came from (LinkedIn, Indeed, ...) and the response rate. " +
        "Use this for questions like 'how is my job search going?'.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const s = await getPipelineSummary();
      const rate = s.sent > 0 ? Math.round((s.responded / s.sent) * 100) : 0;
      return text(
        [
          `Total tracked: ${s.total} (${s.sent} sent, ${s.total - s.sent} on the wishlist)`,
          `Response rate: ${s.responded}/${s.sent} = ${rate}% got an OA, interview, offer or rejection`,
          "By status:",
          ...s.byStatus.map((r) => `- ${r.status}: ${r.count}`),
          "By source:",
          ...s.bySource.map((r) => `- ${r.source}: ${r.count}`),
        ].join("\n"),
      );
    },
  );
}