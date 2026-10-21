// Upcoming interviews, assessments and deadlines from email, offered as calendar events in
// the same approval as the tracker changes: only what the human ticks is added, nothing
// that's already on the calendar is offered, and approving twice adds once.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/db/tx.js";
import { calendarFromEnv } from "../../src/google/calendar.js";
import { selectTracked } from "../../src/google/classify.js";
import type { Extractor } from "../../src/google/extract.js";
import { matchOpportunities } from "../../src/google/match.js";
import { proposeFromMatches } from "../../src/google/proposals.js";
import { syncJobEmails } from "../../src/google/sync.js";
import { executeAction, executeBatch, type Prepared, useCalendar } from "../../src/hitl/actions.js";
import { listAllApplications } from "../../src/repos/applications.js";
import { listClassifiedEmails } from "../../src/repos/email-messages.js";
import { upsertGmailConnection } from "../../src/repos/gmail-connections.js";
import { resetDb, seedApplication } from "../helpers/db.js";
import { fakeCalendar } from "../helpers/fake-calendar.js";
import { email, fakeGmailSource, fixtureEmails } from "../helpers/fake-gmail-source.js";
import { connectClient, textOf } from "../helpers/mcp.js";

const NOW = new Date("2026-10-20T00:00:00Z");
const INTERVIEW = new Date("2026-10-23T09:30:00Z");
const OA_DUE = new Date("2026-10-25T18:29:00Z");
const PAST = new Date("2026-10-01T09:00:00Z");

// Acme: an interview on the 23rd. Globex: an assessment due on the 25th, and an old one.
const extractor: Extractor = {
  model: "fake-gemini",
  async extract(e) {
    if (e.subject.startsWith("Interview invitation")) return { role: null, kind: null, eventAt: INTERVIEW, deadlineAt: null };
    if (e.subject.startsWith("Online assessment")) return { role: null, kind: null, eventAt: null, deadlineAt: OA_DUE };
    if (e.subject.startsWith("Old assessment")) return { role: null, kind: null, eventAt: PAST, deadlineAt: null };
    return { role: null, kind: null, eventAt: null, deadlineAt: null };
  },
};

const inbox = () =>
  fakeGmailSource([
    ...fixtureEmails(),
    email({ id: "a2", threadId: "t-18f0a1", from: "Acme Robotics <talent@acmerobotics.com>", subject: "Interview invitation at Acme Robotics", receivedAt: new Date("2026-10-16T06:00:00Z") }),
    email({ id: "g2", threadId: "t-18f0b2", from: "Globex <hr@globex.com>", subject: "Online assessment for Globex", receivedAt: new Date("2026-10-17T06:00:00Z") }),
    email({ id: "g3", threadId: "t-18f0b2", from: "Globex <hr@globex.com>", subject: "Old assessment for Globex", receivedAt: new Date("2026-09-20T06:00:00Z") }),
  ]);

let connectionId: string;

beforeEach(async () => {
  await resetDb();
  await seedApplication({ company: "Acme Robotics", role: "Software Engineer Intern", status: "interview" });
  await seedApplication({ company: "Globex", role: "Backend Developer", status: "oa" });
  ({ id: connectionId } = await upsertGmailConnection({ email: "me@gmail.com", refreshTokenEnc: "v1.iv.body", scopes: "gmail.readonly" }));
  await syncJobEmails(inbox(), connectionId, { extractor });
});
afterEach(() => useCalendar(calendarFromEnv));

async function propose(calendar?: ReturnType<typeof fakeCalendar>) {
  const { opportunities } = selectTracked(await listClassifiedEmails(connectionId));
  return proposeFromMatches(matchOpportunities(opportunities, await listAllApplications(), { now: NOW }), {
    calendar: calendar?.client,
    now: NOW,
  });
}

type Item = { toolName: string; payload: Record<string, unknown>; summary: string };
const items = (p: Prepared) => (p.payload as { items: Item[] }).items;

describe("offering calendar events", () => {
  it("upcoming dates only: an interview as a 1-hour event, a deadline as a slot ending at it", async () => {
    const { batch } = await propose(fakeCalendar());
    expect(items(batch!).map((i) => [i.toolName, i.payload.title, i.payload.start, i.payload.end, i.payload.remindMinutesBefore])).toEqual([
      ["add_calendar_event", "Interview: Acme Robotics (Software Engineer Intern)", "2026-10-23T09:30:00.000Z", "2026-10-23T10:30:00.000Z", [1440, 60]],
      ["add_calendar_event", "Deadline: Globex (Backend Developer)", "2026-10-25T17:59:00.000Z", "2026-10-25T18:29:00.000Z", [1440, 120]],
    ]);
    const description = String(items(batch!)[0]!.payload.description);
    expect(description).toMatch(/^Added by jobhunt-mcp, with your approval, from an interview email received 2026-10-16/);
    expect(items(batch!)[0]!.summary).toMatch(/^Add to your calendar: "Interview: Acme Robotics/);
  });

  it("something for that organisation already on the calendar around then (a real invite): not offered", async () => {
    const cal = fakeCalendar([{ title: "Acme Robotics <> Manmath: technical round", start: new Date("2026-10-23T09:00:00Z") }]);
    const { batch, skipped } = await propose(cal);
    expect(items(batch!).map((i) => i.payload.title)).toEqual(["Deadline: Globex (Backend Developer)"]);
    expect(skipped).toEqual([{ organization: "Acme Robotics", reason: expect.stringMatching(/already on your calendar around then/) }]);
  });

  it("another event at the same time, for someone else, doesn't count", async () => {
    const cal = fakeCalendar([{ title: "Dentist", start: new Date("2026-10-23T09:30:00Z") }]);
    expect(items((await propose(cal)).batch!)).toHaveLength(2);
  });

  it("no Calendar access: no events, and a note saying how to allow it", async () => {
    const { batch, calendarNote } = await propose();
    expect(batch).toBeNull(); // the tracker already matches
    expect(calendarNote).toMatch(/^2 upcoming interview\/assessment date\(s\) weren't offered.*npm run calendar:connect/);
  });

  it("the calendar can't be read: no events at all, rather than risk doubles", async () => {
    const { OAuthError } = await import("../../src/google/oauth.js");
    const broken = fakeCalendar();
    broken.client.eventsBetween = async () => {
      throw new OAuthError("Calendar API: 500");
    };
    const { batch, calendarNote } = await propose(broken);
    expect(batch).toBeNull();
    expect(calendarNote).toBe("Calendar events weren't offered: Calendar API: 500");
  });
});

describe("approving calendar events", () => {
  it("only the ticked ones are added; approving the same event again adds it once", async () => {
    const cal = fakeCalendar();
    useCalendar(async () => cal.client);
    const { batch } = await propose(cal);
    const done = await withTransaction((c) => executeBatch(c, batch!.payload, "test", [1]));
    expect(done.message).toBe("Applied 1 of 2 changes; 1 not ticked.");
    expect(cal.inserted.map((e) => e.title)).toEqual(["Deadline: Globex (Backend Developer)"]);

    const again = await withTransaction((c) => executeAction(c, "add_calendar_event", items(batch!)[1]!.payload, "test"));
    expect(again).toBe('"Deadline: Globex (Backend Developer)" is already on your calendar.');
    expect(cal.inserted).toHaveLength(1);
  });

  it("calendar gone by approval time: that item fails, the rest of the batch still applies", async () => {
    const cal = fakeCalendar();
    const { batch } = await propose(cal);
    useCalendar(async () => undefined);
    const done = await withTransaction((c) => executeBatch(c, batch!.payload, "test"));
    expect(done.items.map((i) => i.outcome)).toEqual(["failed", "failed"]);
    expect(done.items[0]!.message).toMatch(/Calendar isn't connected/);
  });
});

describe("through propose_email_updates", () => {
  it("events are checkboxes in the same approval as the tracker changes", async () => {
    const cal = fakeCalendar();
    useCalendar(async () => cal.client);
    await seedApplication({ company: "Initech", role: "Full Stack Intern", status: "applied" });
    const mcp = await connectClient({
      elicitation: true,
      gmail: { source: inbox, extractor: () => extractor, calendar: async () => cal.client },
    });
    mcp.human.answer = { action: "accept", content: { item_0: true, item_1: false } };
    const t = textOf(await mcp.call("propose_email_updates"));
    await mcp.close();
    expect(mcp.human.asked[0]).toMatch(/wants to make 2 changes/);
    expect(t).toMatch(/^The user approved\. Applied 1 of 2 changes; 1 not ticked\./);
    expect(cal.inserted.map((e) => e.title)).toEqual(["Interview: Acme Robotics (Software Engineer Intern)"]);
  });
});
