// Opportunities from email next to the tracker: linking, status suggestions, "no reply yet".
import { describe, expect, it } from "vitest";
import type { ClassifiedEmail, EmailCategory, Opportunity } from "../../src/google/classify.js";
import { matchOpportunities, sameRole } from "../../src/google/match.js";
import type { ApplicationRow, ApplicationStatus } from "../../src/repos/applications.js";

const NOW = new Date("2026-10-21T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function opp(organization: string, emails: Array<[EmailCategory, number]>, over: Partial<Opportunity> = {}): Opportunity {
  const list: ClassifiedEmail[] = emails.map(([category, ago], i) => ({
    id: `${organization}-${i}`,
    threadId: `t-${organization}`,
    from: `jobs@${organization.toLowerCase()}.com`,
    subject: category,
    receivedAt: daysAgo(ago),
    category,
    kind: null,
    organization,
  }));
  return { organization, kind: "job", role: null, dates: [], confirmedAt: list[0]!.receivedAt, emails: list, ...over };
}

let n = 0;
function app(company: string, role: string, status: ApplicationStatus = "applied"): ApplicationRow {
  return { id: `app-${++n}`, company, role, status, applied_at: "2026-10-01", source: null, url: null, notes: null };
}

const one = (o: Opportunity, apps: ApplicationRow[], ghostAfterDays?: number) =>
  matchOpportunities([o], apps, { now: NOW, ghostAfterDays })[0]!;

describe("linking an opportunity to the tracker", () => {
  it("links the only application at the organisation, whatever the company's legal suffix", () => {
    const stripe = app("Stripe Inc.", "Backend Engineer");
    const m = one(opp("Stripe", [["applied", 5]]), [app("Globex", "SDE"), stripe]);
    expect(m).toMatchObject({ match: "linked", application: stripe, candidates: [] });
  });

  it("several applications at the organisation and no role in the emails: ambiguous, never a guess", () => {
    const apps = [app("Google", "Software Engineer"), app("Google", "Data Analyst")];
    const m = one(opp("Google", [["applied", 5]]), apps);
    expect(m).toMatchObject({ match: "ambiguous", application: null, suggestedStatus: null });
    expect(m.candidates.map((a) => a.role)).toEqual(["Software Engineer", "Data Analyst"]);
  });

  it("the role from the emails picks between several", () => {
    const analyst = app("Google", "Data Analyst");
    const m = one(opp("Google", [["applied", 5]], { role: "data analyst" }), [app("Google", "Software Engineer"), analyst]);
    expect(m).toMatchObject({ match: "linked", application: analyst });
  });

  it("a stated role that matches none of them is ambiguous, not a link to the wrong one", () => {
    const m = one(opp("Google", [["applied", 5]], { role: "Product Manager" }), [app("Google", "Software Engineer")]);
    expect(m.match).toBe("ambiguous");
  });

  it("nothing at the organisation: untracked, suggested with the status the emails show", () => {
    const m = one(opp("Notion", [["applied", 9], ["interview", 2]]), [app("Stripe", "SDE")]);
    expect(m).toMatchObject({ match: "untracked", application: null, suggestedStatus: "interview" });
  });

  it("deleted applications are not passed in, so they never match", () => {
    expect(one(opp("Wipro", [["applied", 3]]), []).match).toBe("untracked");
  });
});

describe("status from emails", () => {
  it("the newest decisive email wins; an 'update' email moves nothing", () => {
    const m = one(opp("Acme", [["applied", 20], ["assessment", 10], ["interview", 5], ["update", 1]]), [app("Acme", "SDE")]);
    expect(m.emailStatus).toBe("interview");
    expect(m.suggestedStatus).toBe("interview");
  });

  it("a rejection after an interview is suggested", () => {
    const m = one(opp("Acme", [["applied", 20], ["interview", 10], ["rejected", 1]]), [app("Acme", "SDE", "interview")]);
    expect(m.suggestedStatus).toBe("rejected");
  });

  it("never suggests going backwards", () => {
    const m = one(opp("Acme", [["applied", 20], ["assessment", 2]]), [app("Acme", "SDE", "interview")]);
    expect(m).toMatchObject({ emailStatus: "oa", suggestedStatus: null });
  });

  it("never overrides a decision already in the tracker", () => {
    expect(one(opp("Acme", [["applied", 20], ["interview", 2]]), [app("Acme", "SDE", "offer")]).suggestedStatus).toBeNull();
    expect(one(opp("Acme", [["applied", 20], ["offer", 2]]), [app("Acme", "SDE", "rejected")]).suggestedStatus).toBeNull();
  });

  it("a wishlist entry with a confirmation is suggested as applied", () => {
    expect(one(opp("Acme", [["applied", 2]]), [app("Acme", "SDE", "wishlist")]).suggestedStatus).toBe("applied");
  });

  it("tracker already up to date: no suggestion", () => {
    expect(one(opp("Acme", [["applied", 2]]), [app("Acme", "SDE")]).suggestedStatus).toBeNull();
  });
});

describe("no reply yet / ghosted", () => {
  it("only a confirmation, recently: waiting, counted from the last email", () => {
    const m = one(opp("Acme", [["applied", 12], ["update", 4]]), [app("Acme", "SDE")]);
    expect(m.reply).toEqual({ state: "waiting", lastHeardAt: daysAgo(4), daysQuiet: 4 });
  });

  it("quiet for the threshold or longer: ghosted", () => {
    expect(one(opp("Acme", [["applied", 30]]), []).reply).toMatchObject({ state: "ghosted", daysQuiet: 30 });
    expect(one(opp("Acme", [["applied", 29]]), []).reply).toMatchObject({ state: "waiting" });
    expect(one(opp("Acme", [["applied", 10]]), [], 7).reply).toMatchObject({ state: "ghosted" });
  });

  it("an assessment, interview, offer or rejection is a reply", () => {
    for (const c of ["assessment", "interview", "offer", "rejected"] as const) {
      expect(one(opp("Acme", [["applied", 90], [c, 60]]), []).reply).toEqual({ state: "replied" });
    }
  });

  it("a reply you logged in the tracker yourself counts", () => {
    expect(one(opp("Acme", [["applied", 90]]), [app("Acme", "SDE", "interview")]).reply).toEqual({ state: "replied" });
  });

  it("competitions aren't waited on", () => {
    expect(one(opp("HackIndia", [["applied", 90]], { kind: "competition" }), []).reply).toBeNull();
  });

  it("ghosted is a report, never a status: nothing suggests 'rejected' for silence", () => {
    const m = one(opp("Acme", [["applied", 200]]), [app("Acme", "SDE")]);
    expect(m).toMatchObject({ reply: { state: "ghosted" }, suggestedStatus: null });
  });
});

describe("sameRole", () => {
  it.each([
    ["Backend Engineer Intern", "backend engineer (intern)", true],
    ["SDE", "SDE Intern", true],
    ["Software Engineer", "Data Analyst", false],
    ["Engineer", "Engineering Manager", false], // whole words only
  ])("%s ~ %s: %s", (a, b, want) => expect(sameRole(a, b)).toBe(want));
});
