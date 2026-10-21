// Turn what the emails show (match.ts) into tracker changes for the human to approve:
//   linked, emails further along  -> update_application_status, with the email noted
//   not tracked yet                -> add_application, applied on the confirmation's date
// Ambiguous matches and competitions are never proposed; they come back as skipped, with
// the reason. Each change is prepared like any write tool (checked against the database
// now, validated again when applied), and all of them go into ONE batch (apply_batch):
// one approval link, one checkbox per change.

import { localIsoDate } from "../dates.js";
import { ActionError, prepareAdd, prepareBatch, prepareStatusChange, type Prepared } from "../hitl/actions.js";
import type { OpportunityMatch } from "./match.js";

export interface Proposals {
  batch: Prepared | null; // null: nothing to change
  skipped: Array<{ organization: string; reason: string }>;
}

// What add_application stores when no email named the role (rules only, or the extractor
// found none). Edit it afterwards with update_application.
export const UNKNOWN_ROLE = "Role not stated";

export async function proposeFromMatches(matches: OpportunityMatch[]): Promise<Proposals> {
  // Changes to what you already track first, then new applications.
  const changes: Prepared[] = [];
  const adds: Prepared[] = [];
  const skipped: Proposals["skipped"] = [];
  for (const m of matches) {
    const org = m.opportunity.organization;
    try {
      if (m.match === "ambiguous") {
        skipped.push({
          organization: org,
          reason: `${m.candidates.length} applications could be this (${m.candidates.map((a) => a.role).join(", ")}); update the right one yourself`,
        });
      } else if (m.match === "linked" && m.suggestedStatus) {
        changes.push(
          await prepareStatusChange({
            id: m.application!.id,
            status: m.suggestedStatus,
            note: `From Gmail: ${m.evidence.category} email on ${localIsoDate(m.evidence.receivedAt)}`,
          }),
        );
      } else if (m.match === "untracked") {
        if (m.opportunity.kind === "competition") {
          skipped.push({ organization: org, reason: "a competition, not a job application" });
          continue;
        }
        const confirmation = m.opportunity.emails.find((e) => e.category === "applied") ?? m.opportunity.emails[0]!;
        adds.push(
          await prepareAdd({
            company: org,
            role: m.opportunity.role ?? UNKNOWN_ROLE,
            status: m.suggestedStatus!,
            appliedOn: localIsoDate(confirmation.receivedAt),
            source: sourceOf(confirmation.from),
          }),
        );
      }
    } catch (err) {
      // Already tracked, changed meanwhile: nothing to propose for this one.
      if (!(err instanceof ActionError)) throw err;
      skipped.push({ organization: org, reason: err.message });
    }
  }
  const items = [...changes, ...adds];
  const n = items.length;
  return { batch: n ? prepareBatch(`${n} change${n === 1 ? "" : "s"} from your job emails:`, items) : null, skipped };
}

// The job site a confirmation came through: what the tracker calls "source".
const SOURCES: Array<[RegExp, string]> = [
  [/@([\w-]+\.)*linkedin\.com>?$/i, "LinkedIn"],
  [/@([\w-]+\.)*(indeed|indeedemail)\.com>?$/i, "Indeed"],
  [/@([\w-]+\.)*internshala\.com>?$/i, "Internshala"],
  [/@([\w-]+\.)*naukri\.com>?$/i, "Naukri"],
  [/@([\w-]+\.)*unstop\.(com|news)>?$/i, "Unstop"],
  [/@([\w-]+\.)*wellfound\.com>?$/i, "Wellfound"],
];

export function sourceOf(from: string): string | undefined {
  return SOURCES.find(([re]) => re.test(from.trim()))?.[1];
}
