// What a job email says happened, and which emails are worth tracking.
//
// The rule: an opportunity (job, internship, competition, hackathon) is real only if a
// confirmation arrived, from any job site or company: "Thank you for applying", "Your
// application was sent to ...", "Indeed Application: ...", "Successfully submitted",
// "Thanks for registering". Any other email about it (interview,
// assessment, rejection, offer, status update) is tracked only when the same organisation
// (or the same thread) already has a confirmation. Everything else is ignored, however
// job-like its subject: ads that say "confirm your application", job alerts, interview-prep
// newsletters, programs you never applied to.
//
// Sender and subject only, so the rules can be rerun over stored emails whenever they
// change (bodies are never stored). What the email TEXT says (role, dates) is read later,
// by extract.ts, and only for emails this gate lets through.

import type { Extraction } from "./extract.js";

export type EmailCategory = "applied" | "interview" | "assessment" | "rejected" | "offer" | "update" | "not_job";
export type OpportunityKind = "job" | "internship" | "competition";

export interface Classification {
  category: EmailCategory;
  kind: OpportunityKind | null;
  organization: string | null;
}

// Checked first: these look like job email but never confirm anything you did.
const NOISE_SUBJECT = [
  /\bconfirm your (application|spot|details|participation)\b/i, // "X is hiring | Confirm your application"
  /\b(complete|finish|update) your (application|details|interview)\b/i, // never submitted
  /\bis (hiring|promoting)\b/i,
  /\bhiring (alert|drive)\b/i,
  /\b(reopened|pending)\b/i,
  /\bsaved job\b/i,
  /\binterview prep\b|\bprep(are)? for (the |your )?interview\b|\bmock interview\b|\brehearse\b/i,
  /\bjobs? (for you|alert)\b|\bnew jobs?\b|\bmore [\w ]*jobs\b/i,
  /\bwalk[- ]?in\b/i,
];
const NOISE_SENDER = [/jobalert/i, /newsletters?-noreply/i, /jobs-listings@/i, /@match\.indeed\.com/i];

const CONFIRMATION = [
  /^indeed application:/i, // Indeed Apply's "Indeed Application: <role>"
  /\byour application (was|has been) (successfully )?(sent|submitted|received)\b/i,
  /\bapplication (received|submitted)\b/i,
  /\b(has been|was) successfully (submitted|registered)\b/i,
  /\bthank(s| you) for (applying|your application|registering|your registration)\b/i,
  /\bsuccessfully registered\b|\bregistration (is )?(confirmed|successful|complete)\b|\byou('| a)re registered\b/i,
];

// In order: the first match decides.
const UPDATES: Array<[EmailCategory, RegExp]> = [
  ["offer", /\boffer letter\b|\bjob offer\b|\boffer of employment\b|\bpleased to offer\b/i],
  ["rejected", /\bunfortunately\b|\bregret\b|\bnot (been )?(selected|shortlisted|accepted)\b|\bnot moving forward\b|\bnot to proceed\b/i],
  ["assessment", /\bassessment\b|\bcoding (challenge|test|round)\b|\bonline test\b|\btake[- ]home\b|\bhackerrank\b|\bcodility\b/i],
  ["interview", /\binterview\b/i],
  ["update", /\byour application (to|for|at|from|status)\b|\bupdate on your application\b|\bapplication (status|update)\b|\bshortlisted\b/i],
];

export function classifyEmail(e: { from: string; subject: string }): Classification {
  const subject = e.subject.trim();
  const kind = kindOf(subject);
  const organization = organizationOf(e.from, subject);
  if (NOISE_SENDER.some((r) => r.test(e.from)) || NOISE_SUBJECT.some((r) => r.test(subject))) {
    return { category: "not_job", kind: null, organization: null };
  }
  if (CONFIRMATION.some((r) => r.test(subject))) return { category: "applied", kind, organization };
  for (const [category, re] of UPDATES) if (re.test(subject)) return { category, kind, organization };
  return { category: "not_job", kind: null, organization: null };
}

function kindOf(subject: string): OpportunityKind | null {
  if (/\b(hackathon|competition|challenge|ideathon|contest|case study)\b/i.test(subject)) return "competition";
  if (/\bintern(ship)?s?\b/i.test(subject)) return "internship";
  return null; // a LinkedIn "sent to X" doesn't say; the body would (Day 20)
}

// ---------- which organisation an email is about ----------

// Sites that send email on a company's behalf: their name is never the organisation.
const PLATFORM_DOMAINS = [
  "linkedin.com", "internshala.com", "indeed.com", "indeedemail.com", "naukri.com", "unstop.news", "unstop.com",
  "workablemail.com", "workable.com", "greenhouse.io", "greenhouse-mail.io", "lever.co",
  "ashbyhq.com", "smartrecruiters.com", "myworkday.com", "wellfound.com", "younoodle.com",
  "google.com", "gmail.com", "outlook.com", "yahoo.com",
];

// From the subject: "sent to X", "... at X", "... from X", "applying to X", "submitted for X".
const SUBJECT_ORG = [
  /\bsent to (.+)$/i,
  /\s(?:at|@) (.+)$/i,
  /\bapplication from (.+)$/i,
  /\b(?:applying|application|registering|registration|submitted|interest)\s+(?:to|for|at|with|in)\s+(?:the\s+)?(.+)$/i,
];

export function organizationOf(from: string, subject: string): string | null {
  for (const re of SUBJECT_ORG) {
    const m = re.exec(subject);
    const org = m && tidy(m[1]!);
    if (org) return org;
  }
  return organizationFromSender(from);
}

function organizationFromSender(from: string): string | null {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const display = (m?.[1] ?? "").trim();
  const address = (m?.[2] ?? from).trim().toLowerCase();
  const [local = "", domain = ""] = address.split("@");
  const platform = PLATFORM_DOMAINS.find((d) => domain === d || domain.endsWith(`.${d}`));
  if (!platform) {
    // A company's own domain: careers.initech.com → initech
    const labels = domain.split(".");
    return labels.length >= 2 ? labels.at(-2)! : null;
  }
  // Workday mails from <company>@myworkday.com.
  if (platform === "myworkday.com" && local && !/^(no-?reply|notifications?)$/.test(local)) return local;
  // An ATS shows the company as the sender name: "Globex Hiring <no-reply@greenhouse-mail.io>".
  const name = tidy(display.replace(/\b(hiring|recruiting|careers|talent acquisition|team|hr)\b/gi, ""));
  const isPlatformName = name && PLATFORM_DOMAINS.some((d) => d.split(".")[0] === name.toLowerCase());
  return name && !isPlatformName && !/\b(linkedin|internshala|indeed|naukri|unstop|workable|google)\b/i.test(name) ? name : null;
}

function tidy(s: string): string | null {
  const t = s
    .split(/\s[|–—]\s|!/)[0]! // drop " | Confirm your spot" tails
    .replace(/^[\s"'‘’“”:-]+|[\s"'‘’“”.,:;-]+$/g, "")
    .trim();
  return t.length >= 2 ? t : null;
}

// "L’Oréal India Pvt. Ltd." and "l'oreal" are the same organisation.
export function orgKey(name: string): string {
  let k = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/\([^)]*\)/g, " ") // "(YC W21)"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const SUFFIX = /\s(pvt|private|ltd|limited|inc|llc|llp|corp|corporation|co|technologies|technology|solutions|india)$/;
  while (SUFFIX.test(k)) k = k.replace(SUFFIX, "");
  return k;
}

function sameOrg(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(`${short} `);
}

// ---------- the gate ----------

export interface ClassifiedEmail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  receivedAt: Date;
  category: EmailCategory;
  kind: OpportunityKind | null;
  organization: string | null;
  // What the extractor read from the text (extract.ts); undefined = not read yet.
  extracted?: Extraction;
}

export interface Opportunity {
  organization: string; // as the first confirmation wrote it
  kind: OpportunityKind | null; // the rules' guess from subjects, else the extractor's
  role: string | null; // the first role the extractor found
  // The interviews, assessments and deadlines the emails mention, oldest first.
  dates: Array<{ at: Date; what: "event" | "deadline"; category: EmailCategory }>;
  confirmedAt: Date; // the earliest confirmation
  emails: ClassifiedEmail[]; // oldest first: the confirmation(s), then what followed
}

export interface TrackingResult {
  opportunities: Opportunity[]; // most recently confirmed first
  // Emails that sounded like job news but have no confirmation behind them.
  unconfirmed: ClassifiedEmail[];
  notJob: number;
}

export function selectTracked(emails: ClassifiedEmail[]): TrackingResult {
  const sorted = [...emails].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  const opportunities: Array<Opportunity & { key: string; threads: Set<string> }> = [];

  for (const e of sorted) {
    if (e.category !== "applied") continue;
    // A confirmation that names no organisation is its own opportunity, keyed by thread.
    const key = e.organization ? orgKey(e.organization) : `thread:${e.threadId}`;
    const existing = opportunities.find((o) => sameOrg(o.key, key));
    if (existing) {
      existing.emails.push(e);
      existing.threads.add(e.threadId);
      existing.kind ??= e.kind;
    } else {
      opportunities.push({
        key,
        organization: e.organization ?? e.subject,
        kind: e.kind,
        role: null,
        dates: [],
        confirmedAt: e.receivedAt,
        emails: [e],
        threads: new Set([e.threadId]),
      });
    }
  }

  const unconfirmed: ClassifiedEmail[] = [];
  let notJob = 0;
  for (const e of sorted) {
    if (e.category === "applied") continue;
    if (e.category === "not_job") {
      notJob++;
      continue;
    }
    const key = e.organization && orgKey(e.organization);
    const match = opportunities.find((o) => o.threads.has(e.threadId) || (key && sameOrg(o.key, key)));
    if (match) {
      match.emails.push(e);
      match.kind ??= e.kind;
    } else unconfirmed.push(e);
  }

  for (const o of opportunities) {
    o.emails.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    // What the extractor read fills in what subjects didn't say; it never decides membership.
    for (const e of o.emails) {
      const x = e.extracted;
      if (!x) continue;
      o.role ??= x.role;
      o.kind ??= x.kind;
      if (x.eventAt) o.dates.push({ at: x.eventAt, what: "event", category: e.category });
      if (x.deadlineAt) o.dates.push({ at: x.deadlineAt, what: "deadline", category: e.category });
    }
    o.dates.sort((a, b) => a.at.getTime() - b.at.getTime());
  }
  return {
    opportunities: opportunities
      .sort((a, b) => b.confirmedAt.getTime() - a.confirmedAt.getTime())
      .map(({ key: _key, threads: _threads, ...o }) => o),
    unconfirmed,
    notJob,
  };
}
