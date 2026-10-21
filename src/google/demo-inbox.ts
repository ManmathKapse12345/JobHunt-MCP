import type { CalendarClient, CalendarEvent } from "./calendar.js";
import type { Extraction, Extractor } from "./extract.js";
import type { GmailMessage, GmailSource } from "./gmail-source.js";

// A made-up inbox for trying the Gmail tools and recording the demo on the demo database
// (npm run demo:db), with no Google account, no Gemini key and nothing personal on screen.
// On with JOBHUNT_DEMO_INBOX=1 (src/index.ts), and only against a local database.
//
// The story, against the demo tracker (scripts/demo-seed.ts):
//   Razorpay   applied   -> an interview invite for the day after tomorrow (status + event)
//   Microsoft  oa        -> an assessment due in three days (a deadline on the calendar)
//   Postman    applied   -> a rejection
//   Linear     untracked -> a new confirmation, added to the tracker
//   Google     applied   -> confirmed five weeks ago, nothing since: ghosted
// plus two job alerts the rules ignore. Every date is relative to now, so it never goes stale.

const DAY = 86_400_000;

function at(daysFromNow: number, utcHour: number, utcMinute = 0): Date {
  const d = new Date(Date.now() + daysFromNow * DAY);
  d.setUTCHours(utcHour, utcMinute, 0, 0);
  return d;
}

function emails(): GmailMessage[] {
  const m = (id: string, from: string, subject: string, receivedAt: Date): GmailMessage => ({
    id,
    threadId: `t-${id}`,
    from,
    subject,
    receivedAt,
    text: "(demo email)",
  });
  return [
    m("demo-google-1", "LinkedIn <jobs-noreply@linkedin.com>", "Your application was sent to Google", at(-35, 5)),
    m("demo-msft-1", "Indeed <noreply@indeed.com>", "Thank you for applying to Microsoft", at(-16, 6)),
    m("demo-rzp-1", "LinkedIn <jobs-noreply@linkedin.com>", "Your application was sent to Razorpay", at(-12, 4)),
    m("demo-postman-1", "LinkedIn <jobs-noreply@linkedin.com>", "Your application was sent to Postman", at(-9, 7)),
    m("demo-msft-2", "Microsoft Careers <careers@microsoft.com>", "Your online assessment for SDE 1", at(-2, 9)),
    m("demo-linear-1", "Linear Hiring <no-reply@workablemail.com>", "Thank you for applying to Linear", at(-3, 8)),
    m("demo-postman-2", "Postman Recruiting <recruiting@postman.com>", "We regret to inform you", at(-1, 6)),
    m("demo-rzp-2", "Razorpay Talent <talent@razorpay.com>", "Interview invitation at Razorpay", at(-1, 10)),
    m("demo-alert-1", "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", "10 new jobs for you in Bengaluru", at(-1, 3)),
    m("demo-alert-2", "Google Careers <no-reply@google.com>", "Google is hiring | Confirm your application", at(-4, 3)),
  ];
}

// What Gemini would read from each tracked email (the extractor sees content, not ids).
const NONE: Extraction = { role: null, kind: null, eventAt: null, deadlineAt: null };
function extraction(subject: string): Extraction {
  if (subject === "Interview invitation at Razorpay") return { ...NONE, role: "Backend Engineer", kind: "job", eventAt: at(2, 9, 30) }; // 3:00 PM IST
  if (subject === "Your online assessment for SDE 1") return { ...NONE, role: "SDE 1", kind: "job", deadlineAt: at(3, 18, 29) }; // 11:59 PM IST
  if (subject === "Thank you for applying to Linear") return { ...NONE, role: "Frontend Engineer", kind: "job" };
  return NONE;
}

export function demoInbox(): GmailSource {
  return {
    async search(_query, max = 300) {
      return emails()
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
        .slice(0, max)
        .map((e) => e.id);
    },
    async get(id) {
      const e = emails().find((x) => x.id === id);
      if (!e) throw new Error(`demo inbox has no message ${id}`);
      return e;
    },
  };
}

export const demoExtractor: Extractor = { model: "demo", extract: async (e) => extraction(e.subject) };

// Approved demo events land here, in memory, instead of anyone's Google Calendar.
const demoEvents: CalendarEvent[] = [];
export const demoCalendar: CalendarClient = {
  async eventsBetween(from, to) {
    return demoEvents.filter((e) => e.start < to && e.end > from).map((e) => ({ id: e.id, title: e.title, description: e.description }));
  },
  async insert(e) {
    if (demoEvents.some((x) => x.id === e.id)) return "exists";
    demoEvents.push(e);
    return "created";
  },
};
