 // Turn what the emails show (match.ts) into tracker changes for the human to approve:
//   linked, emails further along  -> update_application_status, with the email noted
//   not tracked yet                -> add_application, applied on the confirmation's date
// Ambiguous matches and competitions are never proposed; they come back as skipped, with
// the reason. Each change is prepared like any write tool (checked against the database
// now, validated again when applied), and all of them go into ONE batch (apply_batch):
// one approval link, one checkbox per change.

import { localIsoDate } from "../dates.js";
import {
  ActionError,
  prepareAdd,
  prepareBatch,
  prepareCalendarEvent,
  prepareStatusChange,
  type Prepared,
} from "../hitl/actions.js";
import { type CalendarClient, type CalendarEvent, eventIdFor } from "./calendar.js";
import { orgKey } from "./classify.js";
import { OAuthError } from "./oauth.js";
import type { OpportunityMatch } from "./match.js";

export interface Proposals {
  batch: Prepared | null; // null: nothing to change
  skipped: Array<{ organization: string; reason: string }>;
  // Set when upcoming dates weren't offered for the calendar, and why.
  calendarNote?: string;
}

export interface ProposeOptions {
  // The user's calendar, when Calendar access was granted: upcoming interviews,
  // assessments and deadlines are then offered as events too.
  calendar?: CalendarClient;
  now?: Date;
}

// How long an event lasts, and when to be reminded (minutes before it starts).
const EVENT_MINUTES = 60;
const DEADLINE_MINUTES = 30; // a slot that ends at the deadline
const REMIND = { event: [24 * 60, 60], deadline: [24 * 60, 120] };
// Anything already on the calendar this close, for the same organisation, counts as it.
const SAME_EVENT_WINDOW_MS = 3 * 3_600_000;

// What add_application stores when no email named the role (rules only, or the extractor
// found none). Edit it afterwards with update_application.
export const UNKNOWN_ROLE = "Role not stated";

export async function proposeFromMatches(matches: OpportunityMatch[], opts: ProposeOptions = {}): Promise<Proposals> {
  // Changes to what you already track first, then new applications, then calendar events.
  const changes: Prepared[] = [];
  const adds: Prepared[] = [];
  const events: Prepared[] = [];
  const skipped: Proposals["skipped"] = [];
  const now = opts.now ?? new Date();
  const upcoming = matches
    .flatMap((m) => m.opportunity.dates.filter((d) => d.at > now).map((d) => ({ m, d })))
    .sort((a, b) => a.d.at.getTime() - b.d.at.getTime()); // soonest first
  let calendarNote: string | undefined;
  if (upcoming.length && !opts.calendar) {
    calendarNote = `${upcoming.length} upcoming interview/assessment date(s) weren't offered for your calendar: run npm run calendar:connect to allow that.`;
  }
  if (opts.calendar) {
    try {
      for (const { m, d } of upcoming) {
        const e = calendarEventFor(m, d);
        if (await alreadyOnCalendar(opts.calendar, e, m.opportunity.organization)) {
          skipped.push({ organization: m.opportunity.organization, reason: `"${e.title}" is already on your calendar around then` });
        } else events.push(prepareCalendarEvent(e));
      }
    } catch (err) {
      // Can't check for duplicates: offer no events rather than risk doubles. The tracker
      // changes still go ahead.
      if (!(err instanceof OAuthError)) throw err;
      events.length = 0;
      calendarNote = `Calendar events weren't offered: ${err.message}`;
    }
  }
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
  const items = [...changes, ...adds, ...events];
  const n = items.length;
  return { batch: n ? prepareBatch(`${n} change${n === 1 ? "" : "s"} from your job emails:`, items) : null, skipped, calendarNote };
}

type DateOf = OpportunityMatch["opportunity"]["dates"][number];

export function calendarEventFor(m: OpportunityMatch, d: DateOf): CalendarEvent {
  const o = m.opportunity;
  const role = m.application?.role ?? o.role;
  const name = `${o.organization}${role && role !== UNKNOWN_ROLE ? ` (${role})` : ""}`;
  const kind = d.category === "assessment" ? "Assessment" : d.category === "interview" ? "Interview" : o.kind === "competition" ? "Round" : "Event";
  const [start, end] =
    d.what === "event"
      ? [d.at, new Date(d.at.getTime() + EVENT_MINUTES * 60_000)]
      : [new Date(d.at.getTime() - DEADLINE_MINUTES * 60_000), d.at];
  return {
    id: eventIdFor(d.emailId, d.what, d.at),
    title: d.what === "event" ? `${kind}: ${name}` : `Deadline: ${name}`,
    start,
    end,
    description:
      `Added by jobhunt-mcp, with your approval, from ${/^[aeiou]/.test(d.category) ? "an" : "a"} ${d.category} email received ${localIsoDate(o.emails.find((e) => e.id === d.emailId)?.receivedAt ?? o.confirmedAt)}.\n` +
      "The time was read from the email automatically: check that email for the exact time and the link.",
    remindMinutesBefore: REMIND[d.what],
  };
}

// Gmail adds real calendar invites itself, and you may have added it by hand: anything
// near that time that names the organisation (or is this very event) counts.
async function alreadyOnCalendar(cal: CalendarClient, e: CalendarEvent, organization: string): Promise<boolean> {
  const around = await cal.eventsBetween(new Date(e.start.getTime() - SAME_EVENT_WINDOW_MS), new Date(e.end.getTime() + SAME_EVENT_WINDOW_MS));
  const key = orgKey(organization);
  return around.some((x) => x.id === e.id || (key.length >= 3 && orgKey(`${x.title} ${x.description}`).includes(key)));
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
