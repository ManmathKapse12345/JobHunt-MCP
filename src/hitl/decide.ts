import { withTransaction } from "../db/tx.js";
import {
  claimPendingAction,
  expireOldPendingActions,
  getPendingAction,
  recordOutcome,
  type PendingActionRow,
} from "../repos/pending-actions.js";
import { ActionError, type BatchOutcome, executeAction, executeBatch } from "./actions.js";
import { tokenMatches } from "./token.js";

// Deciding a pending change: the one place that claims it and applies it. The approval
// page (approval-page.ts) and the in-chat panel (tools/approval-app.ts) both call this, so
// they can't drift apart: a change is claimed once, re-checked, applied in one transaction
// (a savepoint per item for a batch), and the outcome recorded.

export type Decision =
  | { kind: "approved"; message: string; items?: BatchOutcome[] }
  | { kind: "rejected" }
  // Approved, but it no longer applies (edited meanwhile, deleted...): nothing changed.
  | { kind: "not-applied"; message: string }
  | { kind: "already"; status: string };

// Wrong id and wrong token look identical, so nobody learns whether an id exists.
export async function findWithToken(id: string, token: string): Promise<PendingActionRow | undefined> {
  await expireOldPendingActions();
  const row = await getPendingAction(id);
  return row && token && tokenMatches(token, row.token_hash) ? row : undefined;
}

// ticked: for a batch, the items to apply (none ticked = reject); undefined = all of them.
export async function decide(
  row: PendingActionRow,
  decision: "approve" | "reject",
  actor: string,
  ticked?: number[],
): Promise<Decision> {
  if (decision === "reject" || (row.tool_name === "apply_batch" && ticked?.length === 0)) {
    const claimed = await withTransaction((client) => claimPendingAction(client, row.id, "rejected"));
    return claimed ? { kind: "rejected" } : alreadyDecided(row.id);
  }
  try {
    // Claim + apply + record in ONE transaction: if applying fails, the claim is undone too.
    const done = await withTransaction(async (client) => {
      const claimed = await claimPendingAction(client, row.id, "approved");
      if (!claimed) return undefined;
      if (claimed.tool_name === "apply_batch") {
        const outcome = await executeBatch(client, claimed.payload, actor, ticked);
        await recordOutcome(client, row.id, { result: outcome });
        return outcome;
      }
      const message = await executeAction(client, claimed.tool_name, claimed.payload, actor);
      await recordOutcome(client, row.id, { result: { message } });
      return { message, items: undefined };
    });
    return done ? { kind: "approved", ...done } : alreadyDecided(row.id);
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    // Close it anyway and keep the reason.
    await withTransaction(async (client) => {
      if (await claimPendingAction(client, row.id, "approved")) await recordOutcome(client, row.id, { error: err.message });
    });
    return { kind: "not-applied", message: err.message };
  }
}

async function alreadyDecided(id: string): Promise<Decision> {
  return { kind: "already", status: (await getPendingAction(id))?.status ?? "gone" };
}
