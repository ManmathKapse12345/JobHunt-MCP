import { describe, expect, it } from "vitest";
import type { RawMessage } from "../../src/google/gmail-api.js";
import { createGmailApiSource, htmlToText, parseMessage } from "../../src/google/gmail-source.js";
import { buildJobQuery } from "../../src/google/job-query.js";
import type { Fetch } from "../../src/google/oauth.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const raw = (payload: RawMessage["payload"]): RawMessage => ({ id: "m1", threadId: "t1", internalDate: "1760000000000", payload });

describe("parseMessage", () => {
  it("reads From, Subject (any case) and the received time", () => {
    const m = parseMessage(
      raw({
        mimeType: "text/plain",
        headers: [
          { name: "from", value: "LinkedIn <jobs-noreply@linkedin.com>" },
          { name: "SUBJECT", value: "Your application was sent to Acme" },
        ],
        body: { data: b64("hello") },
      }),
    );
    expect(m).toEqual({
      id: "m1",
      threadId: "t1",
      from: "LinkedIn <jobs-noreply@linkedin.com>",
      subject: "Your application was sent to Acme",
      receivedAt: new Date(1760000000000),
      text: "hello",
    });
  });

  it("prefers the text/plain part of a multipart message, however deeply nested", () => {
    const m = parseMessage(
      raw({
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/html", body: { data: b64("<p>HTML version</p>") } },
              { mimeType: "text/plain", body: { data: b64("Plain version ✓") } },
            ],
          },
          { mimeType: "application/pdf", body: { size: 1000 } },
        ],
      }),
    );
    expect(m.text).toBe("Plain version ✓");
    expect(m.from).toBe(""); // no headers: empty, not a crash
  });

  it("falls back to the HTML part, as text", () => {
    const m = parseMessage(raw({ mimeType: "text/html", body: { data: b64("<html><head><style>p{}</style></head><p>Hi&nbsp;there</p><p>R&amp;D</p></html>") } }));
    expect(m.text).toBe("Hi there\nR&D");
  });
});

describe("htmlToText", () => {
  it("drops scripts and tags and decodes entities once", () => {
    expect(htmlToText("<script>alert(1)</script>a<br>b &amp;lt;c&amp;gt;")).toBe("a\nb &lt;c&gt;");
  });
});

describe("createGmailApiSource", () => {
  function stubFetch(pages: Array<{ ids: string[]; next?: string }>) {
    const urls: string[] = [];
    const auths: string[] = [];
    const fetch: Fetch = async (input, init) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      auths.push(new Headers(init?.headers).get("authorization") ?? "");
      const page = pages[Number(url.searchParams.get("pageToken") ?? 0)]!;
      const body = { messages: page.ids.map((id) => ({ id, threadId: id })), ...(page.next && { nextPageToken: page.next }) };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return { fetch, urls, auths };
  }
  const auth = { accessToken: async () => ({ token: "ya29.t", email: "me@gmail.com" }) };

  it("follows nextPageToken until it has max ids, sending the query and the token", async () => {
    const f = stubFetch([{ ids: ["a", "b"], next: "1" }, { ids: ["c", "d"], next: "2" }, { ids: ["e"] }]);
    const ids = await createGmailApiSource(auth, f.fetch).search("from:lever.co", 3);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(f.urls).toHaveLength(2); // stopped once it had enough
    expect(new URL(f.urls[0]!).searchParams.get("q")).toBe("from:lever.co");
    expect(new URL(f.urls[1]!).searchParams.get("maxResults")).toBe("1"); // only asks for what's missing
    expect(f.auths).toEqual(["Bearer ya29.t", "Bearer ya29.t"]);
  });

  it("an empty search (no `messages` field) is an empty list", async () => {
    const fetch: Fetch = async () => new Response("{}", { status: 200 });
    expect(await createGmailApiSource(auth, fetch).search("nothing")).toEqual([]);
  });
});

describe("buildJobQuery", () => {
  it("matches job senders or job subjects, excludes job alerts, last 30 days by default", () => {
    const q = buildJobQuery();
    expect(q).toMatch(/^\{from:\(greenhouse\.io OR .*\) subject:\(.*"your application".*\)\} /);
    expect(q).toContain("-from:(jobalerts-noreply@linkedin.com OR jobs-listings@linkedin.com)");
    expect(q).toMatch(/newer_than:30d$/);
  });

  it("adds a label written the way Gmail search expects", () => {
    expect(buildJobQuery({ newerThanDays: 7, label: "Job Hunt" })).toMatch(/newer_than:7d label:job-hunt$/);
  });

  it("refuses a nonsense window", () => {
    expect(() => buildJobQuery({ newerThanDays: 0 })).toThrow();
    expect(() => buildJobQuery({ newerThanDays: 1.5 })).toThrow();
  });
});
