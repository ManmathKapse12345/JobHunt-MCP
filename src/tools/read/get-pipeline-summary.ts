import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPipelineSummary } from "../../repos/applications.js";
import { pipelineText, text } from "../format.js";

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
    async () => text(pipelineText(await getPipelineSummary())),
  );
}
