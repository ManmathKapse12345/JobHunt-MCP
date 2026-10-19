import { describe, expect, it } from "vitest";
import type { ApplicationRow } from "../../src/repos/applications.js";
import type { EventRow } from "../../src/repos/events.js";
import { applicationDetailText, applicationLine, pipelineText, text } from "../../src/tools/format.js";

const app: ApplicationRow = {
  id: "11111111-1111-4111-8111-111111111111",
  company: "Stripe",
  role: "Backend Engineer",
  status: "interview",
  applied_at: "2026-10-01",
  source: "LinkedIn",
  url: "https://stripe.com/jobs/1",
  notes: "recruiter: Asha",
};

const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

describe("text", () => {
  it("only marks errors when asked", () => {
    expect(text("ok")).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(text("no", true)).toMatchObject({ isError: true });
  });
});

describe("applicationLine", () => {
  it("lists the parts that are set", () => {
    expect(applicationLine(app)).toBe(
      "- Backend Engineer at Stripe | interview | applied 2026-10-01 | via LinkedIn (id 11111111-1111-4111-8111-111111111111)",
    );
    expect(applicationLine({ ...app, applied_at: null, source: null })).toBe(
      "- Backend Engineer at Stripe | interview (id 11111111-1111-4111-8111-111111111111)",
    );
  });
});

describe("pipelineText", () => {
  it("computes the response rate", () => {
    const t = pipelineText({
      byStatus: [
        { status: "applied", count: 3 },
        { status: "rejected", count: 1 },
      ],
      bySource: [{ source: "LinkedIn", count: 4 }],
      total: 5,
      sent: 4,
      responded: 1,
    });
    expect(t).toContain("Total tracked: 5 (4 sent, 1 on the wishlist)");
    expect(t).toContain("Response rate: 1/4 = 25%");
    expect(t).toContain("- rejected: 1");
  });

  it("does not divide by zero with nothing sent", () => {
    expect(pipelineText({ byStatus: [], bySource: [], total: 0, sent: 0, responded: 0 })).toContain("= 0%");
  });
});

describe("applicationDetailText", () => {
  it("describes every kind of event", () => {
    const base = { actor: null, note: null, details: null } as const;
    const events: EventRow[] = [
      { ...base, kind: "created", from_status: null, to_status: "applied", occurred_at: at("2026-10-01") },
      {
        ...base,
        kind: "status_change",
        from_status: "applied",
        to_status: "interview",
        occurred_at: at("2026-10-05"),
        note: "phone screen",
        actor: "user via elicitation (Claude)",
      },
      {
        ...base,
        kind: "updated",
        from_status: "interview",
        to_status: "interview",
        occurred_at: at("2026-10-06"),
        details: { before: { notes: null }, after: { notes: "x" } },
      },
      { ...base, kind: "deleted", from_status: "interview", to_status: "interview", occurred_at: at("2026-10-07") },
    ];
    expect(applicationDetailText(app, events)).toBe(
      [
        applicationLine(app),
        "URL: https://stripe.com/jobs/1",
        "Notes: recruiter: Asha",
        "History:",
        "- 2026-10-01: created as applied",
        "- 2026-10-05: applied -> interview (phone screen) [user via elicitation (Claude)]",
        "- 2026-10-06: edited notes",
        "- 2026-10-07: deleted",
      ].join("\n"),
    );
  });
});
