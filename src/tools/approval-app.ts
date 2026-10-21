import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decide, findWithToken } from "../hitl/decide.js";
import { APPROVAL_APP_HTML } from "./approval-app-html.js";
import { text } from "./format.js";

// The approval as an MCP App: hosts that support MCP Apps (Claude Desktop does; it says so
// in its capabilities as extensions["io.modelcontextprotocol/ui"]) show a panel under a
// write tool's result, with Approve / Reject and a checkbox per change, instead of the
// approval link. Hosts without it ignore all of this and the link still works.
//
// The human-only rule holds: the panel decides through decide_approval, a tool the model
// can't see (visibility ["app"]), which needs the change's secret token and runs exactly
// what the approval page runs (hitl/decide.ts). Local (stdio) server only: the deployed
// server requires signing in to approve, which a panel can't do.

export const APPROVAL_APP_URI = "ui://jobhunt/approval.html";
const MIME = "text/html;profile=mcp-app";

// Added to every tool whose result can be a pending approval.
export const approvalUi = { ui: { resourceUri: APPROVAL_APP_URI } };

const withPanel = new WeakSet<McpServer>();

// True when this server offers the panel and the connected client can show it.
export function panelShown(server: McpServer): boolean {
  const ext = server.server.getClientCapabilities()?.extensions as Record<string, { mimeTypes?: string[] }> | undefined;
  return withPanel.has(server) && Boolean(ext?.["io.modelcontextprotocol/ui"]?.mimeTypes?.includes(MIME));
}

export function registerApprovalApp(server: McpServer) {
  withPanel.add(server);
  server.registerResource(
    "approval-panel",
    APPROVAL_APP_URI,
    { title: "Approval panel", description: "Approve or reject a proposed change from the chat.", mimeType: MIME },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: MIME, text: APPROVAL_APP_HTML, _meta: { ui: { prefersBorder: true } } }],
    }),
  );

  server.registerTool(
    "decide_approval",
    {
      title: "Decide Approval (panel only)",
      description:
        "Used only by the approval panel when the user clicks Approve or Reject. Never call this yourself: " +
        "only the user approves changes.",
      inputSchema: {
        id: z.uuid(),
        token: z.string().min(16).max(128),
        decision: z.enum(["approve", "reject"]),
        items: z.array(z.number().int().min(0)).max(100).optional().describe("For a batch: the ticked changes"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: APPROVAL_APP_URI, visibility: ["app"] } },
    },
    async ({ id, token, decision, items }) => {
      const row = await findWithToken(id, token);
      if (!row) {
        return { ...text("This approval expired or was already used. Nothing was changed.", true), structuredContent: { decision: { kind: "invalid" } } };
      }
      const client = server.server.getClientVersion()?.name ?? "unknown client";
      const ticked = row.tool_name === "apply_batch" ? (items ?? []) : undefined;
      const d = await decide(row, decision, `user via approval panel (${client})`, ticked);
      const summary =
        d.kind === "approved" ? `The user approved. ${d.message}`
        : d.kind === "rejected" ? "The user rejected it. Nothing was changed."
        : d.kind === "not-applied" ? `Approved, but not applied: ${d.message}`
        : `Already ${d.status}. Nothing more was done.`;
      return { ...text(summary, d.kind === "not-applied"), structuredContent: { decision: d } };
    },
  );
}
