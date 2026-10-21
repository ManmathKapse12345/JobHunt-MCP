// The Gmail sync against a fake inbox and the real test database: each message is stored
// once however often it runs, and bodies are never stored.
import { beforeEach, describe, expect, it } from "vitest";
import { readPool, writePool } from "../../src/db/pool.js";
import { deleteGmailConnection, upsertGmailConnection } from "../../src/repos/gmail-connections.js";
import { insertEmailMessage } from "../../src/repos/email-messages.js";
import { ExtractError, type Extractor } from "../../src/google/extract.js";
import { syncJobEmails } from "../../src/google/sync.js";
import { matchOpportunities } from "../../src/google/match.js";
import { listAllApplications } from "../../src/repos/applications.js";
import { count, resetDb, seedApplication } from "../helpers/db.js";
import { email, fakeGmailSource, fixtureEmails } from "../helpers/fake-gmail-source.js";

let connectionId: string;

beforeEach(async () => {
  await resetDb();
  const row = await upsertGmailConnection({ email: "me@gmail.com", refreshTokenEnc: "v1.iv.body", scopes: "gmail.readonly" });
  connectionId = row.id;
});

describe("syncJobEmails", () => {
  it("stores every new email's metadata and hands the bodies back in memory", async () => {
    const inbox = fakeGmailSource();
    const result = await syncJobEmails(inbox, connectionId);

    expect(result).toMatchObject({ matched: 3, alreadyStored: 0 });
    expect(result.fresh.map((m) => m.id)).toEqual(["18f0c3", "18f0b2", "18f0a1"]); // newest first
    expect(result.fresh[0]!.text).toContain("technical interview");

    const { rows } = await writePool.query("select gmail_id, from_header, subject from email_messages order by received_at");
    expect(rows).toEqual([
      { gmail_id: "18f0a1", from_header: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Your application was sent to Acme Robotics" },
      { gmail_id: "18f0b2", from_header: "Indeed <noreply@indeed.com>", subject: "Thank you for applying to Globex" },
      { gmail_id: "18f0c3", from_header: "Priya Shah <priya.shah@initech.com>", subject: "Interview: Full Stack Intern at Initech" },
    ]);
  });

  it("never stores a body: no column of any row contains body text", async () => {
    await syncJobEmails(fakeGmailSource(), connectionId);
    const { rows } = await writePool.query("select * from email_messages");
    const stored = JSON.stringify(rows);
    for (const m of fixtureEmails()) expect(stored).not.toContain(m.text.split("\n").at(-1));
  });

  it("is idempotent: syncing the same inbox twice stores each message once, and fetches nothing the second time", async () => {
    const inbox = fakeGmailSource();
    await syncJobEmails(inbox, connectionId);
    const getsAfterFirst = inbox.gets.length;

    const second = await syncJobEmails(inbox, connectionId);
    expect(second).toMatchObject({ matched: 3, alreadyStored: 3, fresh: [] });
    expect(inbox.gets).toHaveLength(getsAfterFirst); // no messages.get for known ids
    expect(await count("email_messages")).toBe(3);
  });

  it("only fetches what arrived since the last sync", async () => {
    const inbox = fakeGmailSource();
    await syncJobEmails(inbox, connectionId);
    inbox.deliver(email({ id: "18f0d4", subject: "Your application was sent to Hooli", receivedAt: new Date("2026-10-19T10:00:00Z") }));
    inbox.gets.length = 0;

    const result = await syncJobEmails(inbox, connectionId);
    expect(result.fresh.map((m) => m.id)).toEqual(["18f0d4"]);
    expect(inbox.gets).toEqual(["18f0d4"]);
    expect(await count("email_messages")).toBe(4);
  });

  it("respects max, and runs the job query", async () => {
    const inbox = fakeGmailSource();
    const result = await syncJobEmails(inbox, connectionId, { max: 2, newerThanDays: 7 });
    expect(result.fresh).toHaveLength(2);
    expect(inbox.searches[0]).toContain("newer_than:7d");
  });

  it("classifies what it stores, and tracks only confirmed opportunities", async () => {
    const inbox = fakeGmailSource();
    const first = await syncJobEmails(inbox, connectionId);
    // Acme and Globex sent confirmations; Initech's interview has none behind it.
    expect(first.tracking.opportunities.map((o) => o.organization)).toEqual(["Globex", "Acme Robotics"]);
    expect(first.tracking.unconfirmed.map((e) => e.subject)).toEqual(["Interview: Full Stack Intern at Initech"]);

    const { rows } = await writePool.query(
      "select subject, category, kind, organization from email_messages order by received_at",
    );
    expect(rows).toEqual([
      { subject: "Your application was sent to Acme Robotics", category: "applied", kind: null, organization: "Acme Robotics" },
      { subject: "Thank you for applying to Globex", category: "applied", kind: null, organization: "Globex" },
      { subject: "Interview: Full Stack Intern at Initech", category: "interview", kind: "internship", organization: "Initech" },
    ]);

    // Initech's confirmation turns up in a later sync: the earlier interview now counts.
    inbox.deliver(
      email({
        id: "18f099",
        from: "LinkedIn <jobs-noreply@linkedin.com>",
        subject: "Thank you for applying to Initech",
        receivedAt: new Date("2026-10-08T10:00:00Z"),
      }),
    );
    const second = await syncJobEmails(inbox, connectionId);
    const initech = second.tracking.opportunities.find((o) => o.organization === "Initech")!;
    expect(initech.emails.map((e) => e.category)).toEqual(["applied", "interview"]);
    expect(second.tracking.unconfirmed).toEqual([]);
  });

  it("reclassifies rows stored before the rules ran (or under older rules)", async () => {
    await insertEmailMessage(connectionId, fixtureEmails()[0]!);
    expect((await writePool.query("select category from email_messages")).rows[0].category).toBeNull();
    await syncJobEmails(fakeGmailSource([]), connectionId);
    expect((await writePool.query("select category from email_messages")).rows[0].category).toBe("applied");
  });

  describe("with an extractor", () => {
    // Records what it was asked to read; answers from a fixed table.
    function fakeExtractor() {
      const read: string[] = [];
      const extractor: Extractor = {
        model: "fake-gemini",
        async extract(e) {
          read.push(e.subject);
          if (e.subject.includes("Globex")) {
            return { role: "Backend Developer", kind: "job", eventAt: null, deadlineAt: null };
          }
          if (e.subject.includes("Initech")) {
            const eventAt = e.category === "interview" ? new Date("2026-10-23T09:30:00Z") : null;
            return { role: "Full Stack Intern", kind: "internship", eventAt, deadlineAt: null };
          }
          return { role: null, kind: null, eventAt: null, deadlineAt: null };
        },
      };
      return { extractor, read };
    }

    it("reads only tracked emails: never one without a confirmation", async () => {
      const { extractor, read } = fakeExtractor();
      const r = await syncJobEmails(fakeGmailSource(), connectionId, { extractor });
      expect(read.sort()).toEqual(["Thank you for applying to Globex", "Your application was sent to Acme Robotics"]);
      expect(r.extracted).toBe(2);
      expect(r.tracking.opportunities.find((o) => o.organization === "Globex")).toMatchObject({ role: "Backend Developer", kind: "job" });
    });

    it("reads each email once, fetching again the ones whose text wasn't kept", async () => {
      const inbox = fakeGmailSource();
      await syncJobEmails(inbox, connectionId); // rules only: nothing read
      const { extractor, read } = fakeExtractor();
      inbox.gets.length = 0;

      const second = await syncJobEmails(inbox, connectionId, { extractor });
      expect(second.extracted).toBe(2);
      expect(inbox.gets.sort()).toEqual(["18f0a1", "18f0b2"]); // re-fetched for their text

      const third = await syncJobEmails(inbox, connectionId, { extractor });
      expect(third.extracted).toBe(0);
      expect(read).toHaveLength(2);
    });

    it("picks up dates, and a later confirmation brings its earlier interview in", async () => {
      const inbox = fakeGmailSource();
      const { extractor } = fakeExtractor();
      await syncJobEmails(inbox, connectionId, { extractor });
      inbox.deliver(
        email({
          id: "18f099",
          from: "LinkedIn <jobs-noreply@linkedin.com>",
          subject: "Thank you for applying to Initech",
          receivedAt: new Date("2026-10-08T10:00:00Z"),
        }),
      );
      const r = await syncJobEmails(inbox, connectionId, { extractor });
      const initech = r.tracking.opportunities.find((o) => o.organization === "Initech")!;
      expect(initech).toMatchObject({ role: "Full Stack Intern", kind: "internship" });
      expect(initech.dates).toEqual([{ at: new Date("2026-10-23T09:30:00Z"), what: "event", category: "interview" }]);
    });

    it("stops at maxExtract and leaves the rest for next time", async () => {
      const { extractor } = fakeExtractor();
      const r = await syncJobEmails(fakeGmailSource(), connectionId, { extractor, maxExtract: 1 });
      expect(r).toMatchObject({ extracted: 1, extractPending: 1 });
      const next = await syncJobEmails(fakeGmailSource(), connectionId, { extractor, maxExtract: 1 });
      expect(next).toMatchObject({ extracted: 1, extractPending: 0 });
    });

    it("a failing extractor (quota used up) stops reading but not the sync", async () => {
      const { extractor } = fakeExtractor();
      let calls = 0;
      const flaky: Extractor = {
        model: extractor.model,
        async extract(e) {
          if (++calls > 1) throw new ExtractError("Gemini quota for m is used up");
          return extractor.extract(e);
        },
      };
      const r = await syncJobEmails(fakeGmailSource(), connectionId, { extractor: flaky });
      expect(r).toMatchObject({ extracted: 1, extractPending: 1, extractStopped: "Gemini quota for m is used up" });
      expect(r.tracking.opportunities).toHaveLength(2);
      const { rows } = await writePool.query("select last_synced_at from gmail_connections where id = $1", [connectionId]);
      expect(rows[0].last_synced_at).toBeInstanceOf(Date);
    });

    it("stores the facts, still never the text", async () => {
      const { extractor } = fakeExtractor();
      await syncJobEmails(fakeGmailSource(), connectionId, { extractor });
      const { rows } = await writePool.query("select * from email_messages");
      const stored = JSON.stringify(rows);
      for (const m of fixtureEmails()) expect(stored).not.toContain(m.text.split("\n").at(-1));
      expect(rows.find((r) => r.subject.includes("Globex"))).toMatchObject({
        role: "Backend Developer",
        extracted_kind: "job",
        extracted_by: "fake-gemini",
      });
    });
  });

  it("records when the account was last synced", async () => {
    await syncJobEmails(fakeGmailSource([]), connectionId);
    const { rows } = await writePool.query("select last_synced_at from gmail_connections where id = $1", [connectionId]);
    expect(rows[0].last_synced_at).toBeInstanceOf(Date);
  });
});

describe("matching synced opportunities to the tracker", () => {
  it("links to live applications only, and reports who hasn't replied", async () => {
    const acme = await seedApplication({ company: "Acme Robotics Pvt. Ltd.", role: "Software Engineer Intern" });
    await seedApplication({ company: "Globex", role: "Backend Developer", deleted: true });
    const { tracking } = await syncJobEmails(fakeGmailSource(), connectionId);

    const matches = matchOpportunities(tracking.opportunities, await listAllApplications(), {
      now: new Date("2026-11-01T00:00:00Z"),
      ghostAfterDays: 20,
    });
    const byOrg = Object.fromEntries(matches.map((m) => [m.opportunity.organization, m]));
    expect(byOrg["Acme Robotics"]).toMatchObject({ match: "linked", application: { id: acme }, suggestedStatus: null });
    // The only Globex application was deleted.
    expect(byOrg.Globex).toMatchObject({ match: "untracked", suggestedStatus: "applied" });
    // Confirmations on Oct 10 and Oct 12, nothing since: 21 and 19 days quiet on Nov 1.
    expect(byOrg["Acme Robotics"]!.reply).toMatchObject({ state: "ghosted", daysQuiet: 21 });
    expect(byOrg.Globex!.reply).toMatchObject({ state: "waiting", daysQuiet: 19 });
  });
});

describe("email_messages", () => {
  it("a message stored by a concurrent sync isn't stored again", async () => {
    const m = fixtureEmails()[0]!;
    expect(await insertEmailMessage(connectionId, m)).toBe(true);
    expect(await insertEmailMessage(connectionId, m)).toBe(false);
    expect(await count("email_messages")).toBe(1);
  });

  it("the same Gmail id under another account is a different message", async () => {
    const other = await upsertGmailConnection({ email: "other@gmail.com", refreshTokenEnc: "v1.iv.body", scopes: "gmail.readonly" });
    const m = fixtureEmails()[0]!;
    await insertEmailMessage(connectionId, m);
    expect(await insertEmailMessage(other.id, m)).toBe(true);
  });

  it("disconnecting Gmail deletes everything read from that account", async () => {
    await syncJobEmails(fakeGmailSource(), connectionId);
    await deleteGmailConnection(connectionId);
    expect(await count("email_messages")).toBe(0);
  });

  it("mcp_reader can't read it (42501)", async () => {
    await expect(readPool.query("select 1 from email_messages")).rejects.toMatchObject({ code: "42501" });
  });
});
