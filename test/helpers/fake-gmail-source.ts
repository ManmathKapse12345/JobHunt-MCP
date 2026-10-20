import type { GmailMessage, GmailSource } from "../../src/google/gmail-source.js";

// A GmailSource that serves fixture emails instead of calling Google. It ignores the query
// (the real search is Gmail's job) and returns every inbox email, newest first.
// Read `searches` and `gets` to see what the sync asked for.
export function fakeGmailSource(inbox: GmailMessage[] = fixtureEmails()) {
  const messages = [...inbox];
  const searches: string[] = [];
  const gets: string[] = [];

  const source: GmailSource = {
    async search(query, max = 100) {
      searches.push(query);
      return [...messages]
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
        .slice(0, max)
        .map((m) => m.id);
    },
    async get(id) {
      gets.push(id);
      const m = messages.find((x) => x.id === id);
      if (!m) throw new Error(`fake-gmail-source: no message ${id}`);
      return m;
    },
  };

  return { ...source, searches, gets, deliver: (m: GmailMessage) => messages.push(m) };
}

export function email(over: Partial<GmailMessage> & Pick<GmailMessage, "id">): GmailMessage {
  return {
    threadId: `t-${over.id}`,
    from: "Someone <someone@example.com>",
    subject: "(no subject)",
    receivedAt: new Date("2026-10-15T09:00:00Z"),
    text: "",
    ...over,
  };
}

// Three realistic job emails. Day 19 grows this into the classifier's fixture set.
export function fixtureEmails(): GmailMessage[] {
  return [
    email({
      id: "18f0a1",
      from: "LinkedIn <jobs-noreply@linkedin.com>",
      subject: "Your application was sent to Acme Robotics",
      receivedAt: new Date("2026-10-10T08:12:00Z"),
      text: "Your application was sent to Acme Robotics.\nSoftware Engineer Intern · Pune (Hybrid)\nApplied on October 10, 2026",
    }),
    email({
      id: "18f0b2",
      from: "Globex Hiring <no-reply@us.greenhouse-mail.io>",
      subject: "Thank you for applying to Globex",
      receivedAt: new Date("2026-10-12T14:30:00Z"),
      text: "Hi Manmath,\nThanks for applying for the Backend Developer role at Globex. Our team will review your application.",
    }),
    email({
      id: "18f0c3",
      from: "Priya Shah <priya.shah@initech.com>",
      subject: "Interview: Full Stack Intern at Initech",
      receivedAt: new Date("2026-10-18T11:05:00Z"),
      text: "Hi Manmath,\nWe'd like to invite you to a 45-minute technical interview on Thursday, October 23 at 3 PM IST.",
    }),
  ];
}
