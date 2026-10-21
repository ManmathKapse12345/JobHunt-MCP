import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../log.js";
import { insertPendingAction } from "../repos/pending-actions.js";
import { batchItems, type Prepared } from "./actions.js";
import { approvalUrl } from "./links.js";
import { hashToken, newToken } from "./token.js";

export type Approval =
  // selected: for apply_batch, the indexes of the items the user ticked.
  | { kind: "approved"; actor: string; selected?: number[] }
  | { kind: "declined"; reason: string }
  // id and token: the in-chat approval panel (tools/approval-app.ts) decides with them.
  | { kind: "pending"; url: string; expiresAt: Date; id: string; token: string };

// How long the approval form may stay open in the client before we give up on it.
const ELICITATION_TIMEOUT_MS = 10 * 60_000;

// The human-in-the-loop gate. Nothing is written before this returns "approved".
//  1. If the client supports elicitation, ask the user directly with a yes/no form.
//  2. Otherwise store the change in pending_actions and return a link the user opens
//     to approve it; the change is applied from that page.
//
// relatedRequestId: over Streamable HTTP, this sends the elicitation on the SSE stream of the
// tool call it belongs to. Without it, it goes to the optional standalone GET stream, which
// only works if the client opened one (the SDK's client does; not every client must). stdio
// ignores it.
export async function requireApproval(
  server: McpServer,
  prepared: Prepared,
  relatedRequestId?: RequestId,
): Promise<Approval> {
  const lowLevel = server.server;

  if (lowLevel.getClientCapabilities()?.elicitation?.form) {
    try {
      if (prepared.toolName === "apply_batch") return await askBatch(server, prepared, relatedRequestId);
      const result = await lowLevel.elicitInput(
        {
          message: `jobhunt-mcp wants to make this change:\n\n${prepared.summary}`,
          requestedSchema: {
            type: "object",
            properties: {
              approve: {
                type: "boolean",
                title: "Approve this change",
                description: "Leave unticked (or decline) to change nothing.",
                default: false,
              },
            },
            required: ["approve"],
          },
        },
        { timeout: ELICITATION_TIMEOUT_MS, relatedRequestId },
      );
      if (result.action === "accept" && result.content?.approve === true) {
        const client = lowLevel.getClientVersion()?.name ?? "unknown client";
        return { kind: "approved", actor: `user via elicitation (${client})` };
      }
      return {
        kind: "declined",
        reason: result.action === "accept" ? "left unticked" : result.action, // decline | cancel
      };
    } catch (err) {
      // Timed out or the client failed: fall through to a link instead of losing the change.
      log.warn({ component: "approvals", tool: prepared.toolName, err }, "elicitation failed, using an approval link instead");
    }
  }

  return { kind: "pending", ...(await createApprovalLink(prepared)) };
}

// A batch: one checkbox per change, all ticked to start with, like the approval page.
async function askBatch(server: McpServer, prepared: Prepared, relatedRequestId?: RequestId): Promise<Approval> {
  const items = batchItems(prepared.payload);
  const result = await server.server.elicitInput(
    {
      message: `jobhunt-mcp wants to make ${items.length} changes. Untick any you don't want.`,
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          items.map((it, i) => [`item_${i}`, { type: "boolean" as const, title: `${i + 1}. ${it.summary}`, default: true }]),
        ),
      },
    },
    { timeout: ELICITATION_TIMEOUT_MS, relatedRequestId },
  );
  if (result.action !== "accept") return { kind: "declined", reason: result.action };
  const selected = items.flatMap((_, i) => (result.content?.[`item_${i}`] === true ? [i] : []));
  if (selected.length === 0) return { kind: "declined", reason: "nothing ticked" };
  const client = server.server.getClientVersion()?.name ?? "unknown client";
  return { kind: "approved", actor: `user via elicitation (${client})`, selected };
}

// Store the change in pending_actions and return its one-time link. Also used without an
// MCP client (npm run gmail:propose).
export async function createApprovalLink(prepared: Prepared): Promise<{ id: string; url: string; expiresAt: Date; token: string }> {
  const token = newToken();
  const row = await insertPendingAction({
    toolName: prepared.toolName,
    payload: prepared.payload,
    summary: prepared.summary,
    tokenHash: hashToken(token),
  });
  log.info({ component: "approvals", tool: prepared.toolName, pendingId: row.id, expiresAt: row.expires_at }, "waiting for approval");
  return { id: row.id, url: approvalUrl(row.id, token), expiresAt: row.expires_at, token };
}
