import { createHash } from "node:crypto";
import { env } from "../config.js";
import { getGmailConnection } from "../repos/gmail-connections.js";
import { type GmailAuth, gmailAuthFromEnv } from "./gmail-auth.js";
import { CALENDAR_EVENTS, OAuthError, ReconnectRequired, type Fetch } from "./oauth.js";

// The user's primary Google Calendar, plain fetch: find events near a time (to avoid
// duplicates) and add one. Events are only ever added after the human approves them
// (add_calendar_event in hitl/actions.ts).
// https://developers.google.com/calendar/api/v3/reference/events

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface CalendarEvent {
  id: string; // ours, derived from the email (eventIdFor): adding it twice is a no-op
  title: string;
  start: Date;
  end: Date;
  description: string;
  remindMinutesBefore: number[];
}

export interface CalendarClient {
  // Titles and descriptions of events overlapping [from, to].
  eventsBetween(from: Date, to: Date): Promise<Array<{ id: string; title: string; description: string }>>;
  // "exists": an event with this id is already there (approved before).
  insert(e: CalendarEvent): Promise<"created" | "exists">;
}

export class CalendarNotConnected extends OAuthError {}

export function createGoogleCalendar(auth: Pick<GmailAuth, "accessToken">, fetchFn: Fetch = fetch): CalendarClient {
  async function call(url: string, init: RequestInit = {}) {
    const { token } = await auth.accessToken();
    const res = await fetchFn(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    });
    if (res.status === 401) throw new ReconnectRequired("Google refused the access token; run npm run calendar:connect again.");
    if (res.status === 403) {
      const body = (await res.clone().json().catch(() => ({}))) as {
        error?: { message?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> };
      };
      const reasons = [...(body.error?.errors ?? []), ...(body.error?.details ?? [])].map((e) => e.reason ?? "");
      if (reasons.some((r) => /accessNotConfigured|SERVICE_DISABLED/i.test(r))) {
        throw new CalendarNotConnected(
          "The Google Calendar API is off for your Google Cloud project: enable it (APIs & Services -> Library -> Google Calendar API), then try again.",
        );
      }
      if (reasons.some((r) => /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(r))) {
        throw new CalendarNotConnected("Calendar access wasn't granted. Run npm run calendar:connect and allow it.");
      }
      throw new OAuthError(`Calendar API: 403${body.error?.message ? ` (${body.error.message})` : ""}`);
    }
    return res;
  }

  return {
    async eventsBetween(from, to) {
      const params = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        maxResults: "50",
      });
      const res = await call(`${API}?${params}`);
      if (!res.ok) throw new OAuthError(`Calendar API: ${res.status}`);
      const body = (await res.json()) as { items?: Array<{ id: string; summary?: string; description?: string }> };
      return (body.items ?? []).map((e) => ({ id: e.id, title: e.summary ?? "", description: e.description ?? "" }));
    },

    async insert(e) {
      const res = await call(API, {
        method: "POST",
        body: JSON.stringify({
          id: e.id,
          summary: e.title,
          description: e.description,
          start: { dateTime: e.start.toISOString() },
          end: { dateTime: e.end.toISOString() },
          reminders: { useDefault: false, overrides: e.remindMinutesBefore.map((minutes) => ({ method: "popup", minutes })) },
        }),
      });
      if (res.status === 409) return "exists"; // the id is taken: approved once already
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new OAuthError(`Calendar API: ${res.status}${body.error?.message ? ` (${body.error.message})` : ""}`);
      }
      return "created";
    },
  };
}

// The calendar of the connected Google account, or undefined when Calendar access was
// never granted (or Google isn't set up at all): calendar features are then skipped.
export async function calendarFromEnv(): Promise<CalendarClient | undefined> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) return undefined;
  const row = await getGmailConnection();
  if (!row?.scopes.split(" ").includes(CALENDAR_EVENTS)) return undefined;
  return createGoogleCalendar(gmailAuthFromEnv());
}

// Same email, same moment, same kind: same event id. Google allows a-v and 0-9 (base32hex);
// hex is a subset.
export function eventIdFor(emailId: string, what: string, at: Date): string {
  return `jh${createHash("sha256").update(`jobhunt|${emailId}|${what}|${at.toISOString()}`).digest("hex").slice(0, 40)}`;
}
