import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getApplicationById, listApplications } from "../repos/applications.js";
import { listEvents } from "../repos/events.js";
import { applicationDetailText } from "../tools/format.js";

// JSON-RPC error code the MCP spec uses for "resource not found".
const RESOURCE_NOT_FOUND = -32002;

// A resource template: one URI pattern, many resources. The SDK matches the requested
// URI against it and hands us the {id} part.
export function registerApplicationResource(server: McpServer) {
  server.registerResource(
    "application",
    new ResourceTemplate("jobhunt://applications/{id}", {
      // Lets clients show concrete URIs to pick from (resources/list), newest first.
      list: async () => ({
        // title too: otherwise each one inherits the template's title ("Job Application"),
        // which clients like the Inspector show instead of the name.
        resources: (await listApplications({ limit: 50 })).map((a) => ({
          uri: `jobhunt://applications/${a.id}`,
          name: `${a.role} at ${a.company}`,
          title: `${a.role} at ${a.company}`,
          description: `Status: ${a.status}`,
          mimeType: "text/plain",
        })),
      }),
    }),
    {
      title: "Job Application",
      description: "One application in full, with its status history. {id} is the application id.",
      mimeType: "text/plain",
    },
    async (uri, { id }) => {
      // The id comes straight from the URI the client sent, so check it before using it.
      const parsed = z.uuid().safeParse(id);
      const app = parsed.success ? await getApplicationById(parsed.data) : undefined;
      if (!app) throw new McpError(RESOURCE_NOT_FOUND, `No application at ${uri.href}`);
      return {
        contents: [
          { uri: uri.href, mimeType: "text/plain", text: applicationDetailText(app, await listEvents(app.id)) },
        ],
      };
    },
  );
}
