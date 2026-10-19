import { afterEach, describe, expect, it, vi } from "vitest";
import { isoDate, todayIso } from "../../src/dates.js";

describe("isoDate", () => {
  it.each(["2026-10-19", "2024-02-29"])("accepts %s", (d) => {
    expect(isoDate.safeParse(d).success).toBe(true);
  });

  it.each(["2026-02-30", "2025-02-29", "2026-1-5", "19-10-2026", "2026/10/19", ""])("rejects %j", (d) => {
    expect(isoDate.safeParse(d).success).toBe(false);
  });
});

describe("todayIso", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the local calendar date, not the UTC one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 19, 0, 30)); // 00:30 local time on 19 Oct
    expect(todayIso()).toBe("2026-10-19");
  });
});
