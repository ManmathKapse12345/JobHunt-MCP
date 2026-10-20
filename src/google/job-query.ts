// The Gmail search the sync runs. Deliberately narrow: the fewer unrelated emails the
// server reads, the less there is to misclassify (and the less of your inbox it touches).
// Gmail search operators: https://support.google.com/mail/answer/7190

// Applicant-tracking systems: everything they send is about an application, so any email
// from them counts. A domain matches its subdomains (hire.lever.co, us.greenhouse-mail.io).
// LinkedIn isn't here: most of its mail is invites and feeds, so it has to match a subject.
export const JOB_SENDERS = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "myworkday.com",
  "ashbyhq.com",
  "smartrecruiters.com",
];

// Job alerts ("30 new jobs for you"): never about an application you made.
export const EXCLUDED_SENDERS = ["jobalerts-noreply@linkedin.com", "jobs-listings@linkedin.com"];

// For LinkedIn and companies that email from their own domain: only clearly
// job-related subjects. (LinkedIn's confirmation is "Your application was sent to ...".)
export const JOB_SUBJECT_KEYWORDS = [
  '"your application"',
  '"application received"',
  '"thank you for applying"',
  '"thanks for applying"',
  "interview",
  "assessment",
  '"coding challenge"',
  "internship",
];

export interface JobQueryOptions {
  newerThanDays?: number; // default 30
  label?: string; // only mail with this Gmail label, e.g. "jobs"
}

export function buildJobQuery(opts: JobQueryOptions = {}): string {
  const days = opts.newerThanDays ?? 30;
  if (!Number.isInteger(days) || days < 1) throw new Error("newerThanDays must be a whole number of days, at least 1");
  // {a b} is OR in Gmail search; a leading "-" excludes.
  const parts = [
    `{from:(${JOB_SENDERS.join(" OR ")}) subject:(${JOB_SUBJECT_KEYWORDS.join(" OR ")})}`,
    `-from:(${EXCLUDED_SENDERS.join(" OR ")})`,
    `newer_than:${days}d`,
  ];
  if (opts.label) parts.push(`label:${quoteLabel(opts.label)}`);
  return parts.join(" ");
}

// Gmail writes spaces in label names as dashes ("Job Hunt" → label:job-hunt).
function quoteLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "-");
}
