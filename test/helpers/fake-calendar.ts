import type { CalendarClient, CalendarEvent } from "../../src/google/calendar.js";

// An in-memory Google Calendar: what was added, and what was already there.
export function fakeCalendar(existing: Array<{ id?: string; title: string; start: Date; end?: Date; description?: string }> = []) {
  const events: CalendarEvent[] = existing.map((e, i) => ({
    id: e.id ?? `existing${i}`,
    title: e.title,
    start: e.start,
    end: e.end ?? new Date(e.start.getTime() + 3_600_000),
    description: e.description ?? "",
    remindMinutesBefore: [],
  }));
  const inserted: CalendarEvent[] = [];
  const client: CalendarClient = {
    async eventsBetween(from, to) {
      return events
        .filter((e) => e.start < to && e.end > from)
        .map((e) => ({ id: e.id, title: e.title, description: e.description }));
    },
    async insert(e) {
      if (events.some((x) => x.id === e.id)) return "exists";
      events.push(e);
      inserted.push(e);
      return "created";
    },
  };
  return { client, events, inserted };
}
