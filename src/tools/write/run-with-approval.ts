import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTransaction } from "../../db/tx.js";
import { ActionError, executeAction, type Prepared } from "../../hitl/actions.js";
import { requireApproval } from "../../hitl/requireApproval.js";
import { text } from "../format.js";

// Shared body of every write tool: prepare -> ask the human -> apply (or hand back a link).
export async function runWithApproval(server: McpServer, prepare: () => Promise<Prepared>) {
  let prepared: Prepared;
  try {
    prepared = await prepare();
  } catch (err) {
    if (err instanceof ActionError) return text(err.message, true);
    throw err;
  }

  const approval = await requireApproval(server, prepared);

  switch (approval.kind) {
    case "approved":
      try {
        const message = await withTransaction((client) =>
          executeAction(client, prepared.toolName, prepared.payload, approval.actor),
        );
        console.error(`${prepared.toolName}: approved and applied`);
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
          `(it expires ${approval.expiresAt.toISOString()}):\n${approval.url}\n\n` +
          `Change waiting for approval:\n${prepared.summary}`,
      );
  }
}
