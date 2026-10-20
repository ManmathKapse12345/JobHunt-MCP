// The classifier and the confirmation gate, against a real (renamed) inbox.
import { describe, expect, it } from "vitest";
import {
  type ClassifiedEmail,
  classifyEmail,
  orgKey,
  organizationOf,
  selectTracked,
} from "../../src/google/classify.js";
import { INBOX_SAMPLE } from "../helpers/inbox-sample.js";

function classifiedSample(): ClassifiedEmail[] {
  return INBOX_SAMPLE.map((s, i) => ({
    id: `m${i}`,
    threadId: `t${i}`,
    from: s.from,
    subject: s.subject,
    receivedAt: new Date(`${s.date}T09:00:00Z`),
    ...classifyEmail(s),
  }));
}

describe("the confirmation gate on a real inbox", () => {
  const { opportunities, unconfirmed, notJob } = selectTracked(classifiedSample());
  const trackedOrg = new Map<string, string>(); // subject+date -> organisation it was tracked under
  for (const o of opportunities) for (const e of o.emails) trackedOrg.set(`${e.receivedAt.toISOString()}|${e.subject}`, o.organization);

  it.each(INBOX_SAMPLE.map((s) => [s.track ? "tracks" : "ignores", s.subject, s] as const))("%s: %s", (_verb, _subject, s) => {
    expect(trackedOrg.get(`${new Date(`${s.date}T09:00:00Z`).toISOString()}|${s.subject}`) ?? null).toBe(s.track);
  });

  it("finds each confirmed opportunity once (two hackathon confirmations are one opportunity)", () => {
    expect(opportunities.map((o) => o.organization).sort()).toEqual(
      [...new Set(INBOX_SAMPLE.flatMap((s) => (s.track ? [s.track] : [])))].sort(),
    );
    const hackathon = opportunities.find((o) => o.organization.includes("Hackathon"))!;
    expect(hackathon).toMatchObject({ kind: "competition", confirmedAt: new Date("2026-09-27T09:00:00Z") });
    expect(hackathon.emails).toHaveLength(2);
  });

  it("keeps a follow-up with its confirmation, in date order", () => {
    const sea = opportunities.find((o) => o.organization === "Sea Buddies")!;
    expect(sea.emails.map((e) => e.category)).toEqual(["applied", "update"]);
  });

  it("reports what it ignored", () => {
    expect(unconfirmed.length + notJob + opportunities.flatMap((o) => o.emails).length).toBe(INBOX_SAMPLE.length);
    expect(unconfirmed.map((e) => e.subject)).toContain("An update on your application from Nebula Labs Technologies");
  });
});

describe("classifyEmail", () => {
  it.each([
    ["Thank you for applying to Globex", "applied"],
    ["Thanks for registering for CodeSprint 2026", "applied"],
    ["You have successfully registered for HackIndia", "applied"],
    ["Your application has been received", "applied"],
    ["Interview: Full Stack Intern at Initech", "interview"],
    ["Invitation: online assessment for Globex", "assessment"],
    ["Your HackerRank coding test for Initech", "assessment"],
    ["Unfortunately, we won't be moving forward", "rejected"],
    ["Your offer letter from Globex", "offer"],
    ["An update on your application from Globex", "update"],
    ["Globex is hiring | Confirm your application", "not_job"],
    ["Complete your application for Globex", "not_job"],
    ["Your weekly newsletter", "not_job"],
  ])("%s → %s", (subject, category) => {
    expect(classifyEmail({ from: "Globex <jobs@globex.com>", subject }).category).toBe(category);
  });

  it("knows competitions and internships from the subject", () => {
    expect(classifyEmail({ from: "x@y.com", subject: "Thanks for registering for the Build Hackathon" }).kind).toBe("competition");
    expect(classifyEmail({ from: "x@y.com", subject: "Thank you for applying: SDE Intern" }).kind).toBe("internship");
    expect(classifyEmail({ from: "x@y.com", subject: "Thank you for applying" }).kind).toBeNull();
  });
});

describe("organizationOf", () => {
  it.each([
    ["LinkedIn <jobs-noreply@linkedin.com>", "Alex, your application was sent to Acme Robotics", "Acme Robotics"],
    ["Workable <noreply@candidates.workablemail.com>", "Thanks for applying to Localy App", "Localy App"],
    ["Globex Hiring <no-reply@us.greenhouse-mail.io>", "Thank you for applying!", "Globex"],
    ["acme@myworkday.com", "Thank You For Applying!", "acme"],
    ["Priya Shah <priya.shah@careers.initech.com>", "Next steps", "initech"],
    ["LinkedIn <jobs-noreply@linkedin.com>", "Your application to SDE (Backend) at Sea Buddies", "Sea Buddies"],
    ["LinkedIn <jobs-noreply@linkedin.com>", "Your application", null],
  ])("%s / %s → %s", (from, subject, org) => {
    expect(organizationOf(from, subject)).toBe(org);
  });

  it("treats spellings of one company as the same key", () => {
    expect(orgKey("L’Oréal India Pvt. Ltd.")).toBe(orgKey("l'oreal"));
    expect(orgKey("Fortnight (YC W21)")).toBe("fortnight");
    expect(orgKey("Nebula Labs Technologies")).toBe("nebula labs");
  });
});

describe("selectTracked", () => {
  const e = (over: Partial<ClassifiedEmail> & Pick<ClassifiedEmail, "id" | "subject">): ClassifiedEmail => ({
    threadId: `t-${over.id}`,
    from: "x@y.com",
    receivedAt: new Date("2026-10-10T00:00:00Z"),
    ...classifyEmail({ from: over.from ?? "x@y.com", subject: over.subject }),
    ...over,
  });

  it("an interview without a confirmation is not tracked; once the confirmation is there, it is", () => {
    const interview = e({ id: "2", from: "HR <hr@initech.com>", subject: "Interview: SDE at Initech", receivedAt: new Date("2026-10-15") });
    expect(selectTracked([interview]).opportunities).toEqual([]);

    const applied = e({ id: "1", from: "Initech Careers <careers@initech.com>", subject: "Thank you for applying to Initech" });
    const { opportunities, unconfirmed } = selectTracked([interview, applied]);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]!.emails.map((x) => x.id)).toEqual(["1", "2"]);
    expect(unconfirmed).toEqual([]);
  });

  it("a reply in the confirmation's thread counts even when it names no company", () => {
    const applied = e({ id: "1", threadId: "T", subject: "Thank you for applying to Globex" });
    const reply = e({ id: "2", threadId: "T", subject: "Re: interview", receivedAt: new Date("2026-10-12") });
    expect(selectTracked([applied, reply]).opportunities[0]!.emails).toHaveLength(2);
  });

  it("a confirmation that names no organisation still counts, on its own", () => {
    const applied = e({ id: "1", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Thank you for applying" });
    expect(selectTracked([applied]).opportunities).toMatchObject([{ organization: "Thank you for applying" }]);
  });
});
