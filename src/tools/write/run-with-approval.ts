import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import { withTransaction } from "../../db/tx.js";
import { ActionError, executeAction, executeBatch, type Prepared } from "../../hitl/actions.js";
import { requireApproval } from "../../hitl/requireApproval.js";
import { log } from "../../log.js";
import { PENDING_TTL_MINUTES } from "../../repos/pending-actions.js";
import { text } from "../format.js";

// Shared body of every write tool: prepare -> ask the human -> apply (or hand back a link).
// requestId is the tool call's own id, so over HTTP the approval question travels on
// that call's response stream.
export async function runWithApproval(
  server: McpServer,
  requestId: RequestId,
  prepare: () => Promise<Prepared>,
) {
  let prepared: Prepared;
  try {
    prepared = await prepare();
  } catch (err) {
    if (err instanceof ActionError) return text(err.message, true);
    throw err;
  }

  const approval = await requireApproval(server, prepared, requestId);

  switch (approval.kind) {
    case "approved":
      try {
        const message = await withTransaction(async (client) => {
          if (prepared.toolName !== "apply_batch" || !approval.selected) {
            return executeAction(client, prepared.toolName, prepared.payload, approval.actor);
          }
          const done = await executeBatch(client, prepared.payload, approval.actor, approval.selected);
          return [done.message, ...done.items.map((it) => `- ${it.outcome}: ${it.summary}${it.outcome === "failed" ? ` (${it.message})` : ""}`)].join("\n");
        });
        log.info({ component: "approvals", tool: prepared.toolName, actor: approval.actor }, "approved and applied");
        return text(`The user approved. ${message}`);
      } catch (err) {
        if (err instanceof ActionError) return text(`Approved, but not applied: ${err.message}`, true);
        throw err;
      }

    case "declined":
      return text(`The user did not approve (${approval.reason}). Nothing was changed.`);

    case "pending":
      return text(
        "Nothing has changed yet: this needs the user's approval.\n" +
          "Give the user this link to review and approve or reject it " +
          `(it expires in ${PENDING_TTL_MINUTES} minutes, at ${approval.expiresAt.toISOString()}):\n${approval.url}\n\n` +
          `Change waiting for approval:\n${prepared.summary}`,
      );
  }
}
