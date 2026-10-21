// Confirmed opportunities from email (classify.ts) next to the applications in the tracker:
// which application each one is, what the emails say its status is, and which ones have
// heard nothing back.
//
// Read-only. Suggestions are only suggestions: applying one is a tracker write, so it goes
// through the approval gate like any other (Day 22).
//
// "Ghosted" is computed every time, never stored: it is not an application status, and it
// is not a rejection (counting it as one would inflate the response rate).

import type { ApplicationRow, ApplicationStatus } from "../repos/applications.js";
import { type EmailCategory, type Opportunity, orgKey, sameOrg } from "./classify.js";

export interface OpportunityMatch {
  opportunity: Opportunity;
  // linked: exactly one application. ambiguous: several could be it (see candidates).
  // untracked: none at that organisation.
  match: "linked" | "ambiguous" | "untracked";
  application: ApplicationRow | null;
  candidates: ApplicationRow[];
  // The status the newest decisive email implies (applied, oa, interview, offer, rejected).
  emailStatus: ApplicationStatus;
  // linked: the tracker is behind the emails. untracked: the status to add it with.
  suggestedStatus: ApplicationStatus | null;
  reply: Reply;
}

// replied: an assessment, interview, offer or rejection came (or the tracker already shows one).
// waiting / ghosted: nothing yet; ghosted once quiet for ghostAfterDays.
// null: not something you wait to hear back on (hackathons, competitions).
export type Reply = { state: "replied" } | { state: "waiting" | "ghosted"; lastHeardAt: Date; daysQuiet: number } | null;

export interface MatchOptions {
  now?: Date;
  ghostAfterDays?: number; // default 30
}

export const DEFAULT_GHOST_AFTER_DAYS = 30;

const STATUS_OF: Partial<Record<EmailCategory, ApplicationStatus>> = {
  applied: "applied",
  assessment: "oa",
  interview: "interview",
  offer: "offer",
  rejected: "rejected",
  // "update" says something changed but not what: it moves nothing.
};

// How far along each status is. offer and rejected are both the end.
const RANK: Record<ApplicationStatus, number> = { wishlist: 0, applied: 1, oa: 2, interview: 3, offer: 4, rejected: 4 };
const REPLIES: EmailCategory[] = ["assessment", "interview", "offer", "rejected"];
const DAY_MS = 86_400_000;

export function matchOpportunities(
  opportunities: Opportunity[],
  applications: ApplicationRow[],
  opts: MatchOptions = {},
): OpportunityMatch[] {
  const now = opts.now ?? new Date();
  const ghostAfterDays = opts.ghostAfterDays ?? DEFAULT_GHOST_AFTER_DAYS;

  return opportunities.map((opportunity) => {
    const key = orgKey(opportunity.organization);
    const atOrg = applications.filter((a) => sameOrg(orgKey(a.company), key));
    const byRole = opportunity.role ? atOrg.filter((a) => sameRole(a.role, opportunity.role!)) : [];
    // A stated role must match exactly one application. With no role in the emails, the
    // only application at the organisation is it. Anything else is for the human to pick.
    const application = (opportunity.role ? (byRole.length === 1 ? byRole[0] : null) : atOrg.length === 1 ? atOrg[0] : null) ?? null;
    const match = application ? "linked" : atOrg.length > 0 ? "ambiguous" : "untracked";

    const emailStatus = statusFromEmails(opportunity);
    const suggestedStatus =
      match === "untracked" ? emailStatus : application && isAhead(emailStatus, application.status) ? emailStatus : null;

    return {
      opportunity,
      match,
      application,
      candidates: match === "ambiguous" ? atOrg : [],
      emailStatus,
      suggestedStatus,
      reply: replyOf(opportunity, application, now, ghostAfterDays),
    };
  });
}

// The newest email that says where things stand; an opportunity always has its confirmation.
function statusFromEmails(o: Opportunity): ApplicationStatus {
  for (let i = o.emails.length - 1; i >= 0; i--) {
    const s = STATUS_OF[o.emails[i]!.category];
    if (s) return s;
  }
  return "applied";
}

// Only forward, and never past a decision already in the tracker.
function isAhead(fromEmail: ApplicationStatus, inTracker: ApplicationStatus): boolean {
  if (inTracker === "offer" || inTracker === "rejected") return false;
  return RANK[fromEmail] > RANK[inTracker];
}

function replyOf(o: Opportunity, app: ApplicationRow | null, now: Date, ghostAfterDays: number): Reply {
  if (o.kind === "competition") return null;
  // A reply you logged yourself (a phone call, a portal message) counts too.
  if (o.emails.some((e) => REPLIES.includes(e.category)) || (app && RANK[app.status] > RANK.applied)) {
    return { state: "replied" };
  }
  const lastHeardAt = o.emails.at(-1)!.receivedAt;
  const daysQuiet = Math.floor((now.getTime() - lastHeardAt.getTime()) / DAY_MS);
  return { state: daysQuiet >= ghostAfterDays ? "ghosted" : "waiting", lastHeardAt, daysQuiet };
}

// "Backend Engineer Intern" and "backend engineer (intern)", or one inside the other
// ("SDE" in "SDE Intern"). Different titles for the same job don't match: that's ambiguous.
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function sameRole(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)];
  if (!x || !y) return false;
  return x === y || ` ${y} `.includes(` ${x} `) || ` ${x} `.includes(` ${y} `);
}
