import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import { insertPendingAction } from "../repos/pending-actions.js";
import type { Prepared } from "./actions.js";
import { approvalUrl } from "./links.js";
import { hashToken, newToken } from "./token.js";

export type Approval =
  | { kind: "approved"; actor: string }
  | { kind: "declined"; reason: string }
  | { kind: "pending"; url: string; expiresAt: Date };

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
      console.error("requireApproval: elicitation failed, using an approval link instead:", err);
    }
  }

  const token = newToken();
  const row = await insertPendingAction({
    toolName: prepared.toolName,
    payload: prepared.payload,
    summary: prepared.summary,
    tokenHash: hashToken(token),
  });
  console.error(`requireApproval: ${prepared.toolName} waiting for approval (pending ${row.id})`);
  return { kind: "pending", url: approvalUrl(row.id, token), expiresAt: row.expires_at };
}
