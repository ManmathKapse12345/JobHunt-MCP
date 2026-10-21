import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isoDate } from "../../dates.js";
import {
  ActionError,
  MAX_BATCH_ITEMS,
  prepareAdd,
  prepareBatch,
  prepareStatusChange,
  prepareUpdate,
  type Prepared,
} from "../../hitl/actions.js";
import { APPLICATION_STATUSES } from "../../repos/applications.js";
import { text } from "../format.js";
import { runWithApproval } from "./run-with-approval.js";

// Several changes in ONE approval: a list with a checkbox per change, and only the ticked
// ones apply (apply_batch). Each change is checked now exactly like the single tools do;
// one that can't apply (already that status, already tracked) is listed, not sent.
// Deletes are not batchable: delete_application, one at a time.

const Status = z.enum(APPLICATION_STATUSES);

const Change = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status"),
    id: z.uuid().describe("Application id"),
    status: Status.describe("The new stage"),
    note: z.string().trim().min(1).optional().describe("Why, e.g. 'no reply in 6 weeks'"),
  }),
  z.object({
    action: z.literal("edit"),
    id: z.uuid().describe("Application id"),
    role: z.string().trim().min(1).optional(),
    url: z.url().optional(),
    source: z.string().trim().min(1).optional(),
    notes: z.string().trim().min(1).optional().describe("Replaces the existing notes"),
    appliedOn: isoDate.optional(),
  }),
  z.object({
    action: z.literal("add"),
    company: z.string().trim().min(1),
    role: z.string().trim().min(1),
    status: Status.default("applied"),
    appliedOn: isoDate.optional(),
    url: z.url().optional(),
    source: z.string().trim().min(1).optional(),
    notes: z.string().trim().min(1).optional(),
  }),
]);
type Change = z.infer<typeof Change>;

function prepare(c: Change): Promise<Prepared> {
  if (c.action === "status") return prepareStatusChange(c);
  if (c.action === "edit") return prepareUpdate(c);
  return prepareAdd(c);
}

export function registerProposeChanges(server: McpServer) {
  server.registerTool(
    "propose_changes",
    {
      title: "Propose Several Changes",
      description:
        "Use this whenever you want to change TWO OR MORE applications (e.g. mark several stale ones rejected, " +
        "move a few to interview, add a list of jobs). All changes go to the user in ONE approval: a list with a " +
        "checkbox per change, and only the ticked ones are applied. Never call update_application_status, " +
        "update_application or add_application once per item for a list of changes. " +
        "First list the changes for the user and make sure they want them; never decide statuses yourself " +
        "(e.g. don't mark silent applications rejected unless the user asked). Deletes can't be batched. " +
        "If the reply contains an approval link, show it to the user.",
      inputSchema: {
        changes: z
          .array(Change)
          .min(1)
          .max(MAX_BATCH_ITEMS)
          .describe('Each change: {action:"status", id, status, note?} | {action:"edit", id, ...fields} | {action:"add", company, role, ...}'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ changes }, extra) => {
      const prepared: Prepared[] = [];
      const problems: string[] = [];
      for (const [i, c] of changes.entries()) {
        try {
          prepared.push(await prepare(c));
        } catch (err) {
          if (!(err instanceof ActionError)) throw err;
          problems.push(`- change ${i + 1}: ${err.message}`);
        }
      }
      const notSent = problems.length ? `Not included (${problems.length}):\n${problems.join("\n")}` : "";
      if (prepared.length === 0) return text(["Nothing to approve.", notSent].filter(Boolean).join("\n\n"), true);
      const n = prepared.length;
      const result = await runWithApproval(server, extra.requestId, async () =>
        prepareBatch(`${n} change${n === 1 ? "" : "s"} to your tracker:`, prepared),
      );
      return notSent ? { ...result, content: [...result.content, { type: "text" as const, text: notSent }] } : result;
    },
  );
}
