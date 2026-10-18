import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPipelineSummary } from "../repos/applications.js";
import { pipelineText } from "../tools/format.js";

export const PIPELINE_URI = "jobhunt://pipeline";

// A static resource: one fixed URI. Same data as the get_pipeline_summary tool, but the
// user (or app) attaches it as context, instead of the model deciding to call it.
export function registerPipelineResource(server: McpServer) {
  server.registerResource(
    "pipeline",
    PIPELINE_URI,
    {
      title: "Job Search Pipeline",
      description: "Counts by status and source, and the response rate, across all tracked applications.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: pipelineText(await getPipelineSummary()) }],
    }),
  );
}
