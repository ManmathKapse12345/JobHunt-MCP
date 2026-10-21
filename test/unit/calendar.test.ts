// The Google Calendar client without calling Google: what it sends, and how it reads errors.
import { describe, expect, it } from "vitest";
import { CalendarNotConnected, createGoogleCalendar, eventIdFor } from "../../src/google/calendar.js";
import { OAuthError, ReconnectRequired, type Fetch } from "../../src/google/oauth.js";

const auth = { accessToken: async () => ({ token: "ya29.test", email: "me@gmail.com" }) };
const event = {
  id: eventIdFor("18f0c3", "event", new Date("2026-10-23T09:30:00Z")),
  title: "Interview: Initech (Full Stack Intern)",
  start: new Date("2026-10-23T09:30:00Z"),
  end: new Date("2026-10-23T10:30:00Z"),
  description: "Added by jobhunt-mcp",
  remindMinutesBefore: [1440, 60],
};

function recording(reply: () => Response) {
  const seen: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
  const fetch: Fetch = async (url, init) => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return reply();
  };
  return { fetch, seen };
}

const err403 = (reason: string) => () =>
  new Response(JSON.stringify({ error: { code: 403, message: "nope", errors: [{ reason }] } }), { status: 403 });

describe("createGoogleCalendar", () => {
  it("inserts on the primary calendar with our id, the times and popup reminders", async () => {
    const { fetch, seen } = recording(() => new Response("{}", { status: 200 }));
    expect(await createGoogleCalendar(auth, fetch).insert(event)).toBe("created");
    expect(seen[0]).toMatchObject({
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      method: "POST",
      auth: "Bearer ya29.test",
      body: {
        id: event.id,
        summary: event.title,
        start: { dateTime: "2026-10-23T09:30:00.000Z" },
        end: { dateTime: "2026-10-23T10:30:00.000Z" },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }, { method: "popup", minutes: 60 }] },
      },
    });
  });

  it("409 (that id is taken): already added, not an error", async () => {
    const { fetch } = recording(() => new Response("{}", { status: 409 }));
    expect(await createGoogleCalendar(auth, fetch).insert(event)).toBe("exists");
  });

  it("lists events in a window, one row per occurrence", async () => {
    const { fetch, seen } = recording(
      () => new Response(JSON.stringify({ items: [{ id: "a", summary: "Interview with Initech" }, { id: "b" }] }), { status: 200 }),
    );
    const got = await createGoogleCalendar(auth, fetch).eventsBetween(new Date("2026-10-23T06:00:00Z"), new Date("2026-10-23T13:00:00Z"));
    expect(got).toEqual([
      { id: "a", title: "Interview with Initech", description: "" },
      { id: "b", title: "", description: "" },
    ]);
    const q = new URL(seen[0]!.url).searchParams;
    expect([q.get("timeMin"), q.get("timeMax"), q.get("singleEvents")]).toEqual(["2026-10-23T06:00:00.000Z", "2026-10-23T13:00:00.000Z", "true"]);
  });

  it("says which 403 it is: the API is off, or access wasn't granted", async () => {
    await expect(createGoogleCalendar(auth, recording(err403("accessNotConfigured")).fetch).insert(event)).rejects.toThrow(
      /enable it \(APIs & Services/,
    );
    const scope = createGoogleCalendar(auth, recording(err403("insufficientPermissions")).fetch).insert(event);
    await expect(scope).rejects.toThrow(CalendarNotConnected);
    await expect(createGoogleCalendar(auth, recording(err403("forbidden")).fetch).insert(event)).rejects.toThrow(OAuthError);
  });

  it("401: reconnect", async () => {
    const { fetch } = recording(() => new Response("{}", { status: 401 }));
    await expect(createGoogleCalendar(auth, fetch).eventsBetween(new Date(), new Date())).rejects.toThrow(ReconnectRequired);
  });
});

describe("eventIdFor", () => {
  it("is what Google accepts (a-v, 0-9) and the same for the same email, kind and time", () => {
    const at = new Date("2026-10-23T09:30:00Z");
    expect(event.id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(eventIdFor("18f0c3", "event", at)).toBe(event.id);
    expect(eventIdFor("18f0c3", "deadline", at)).not.toBe(event.id);
    expect(eventIdFor("other", "event", at)).not.toBe(event.id);
  });
});
