import { describe, expect, it } from "vitest";
import {
  clearedSessionCookie,
  clearLoginFailures,
  loginBlocked,
  newSessionValue,
  readCookie,
  recordLoginFailure,
  sessionCookie,
  sessionIsValid,
  SESSION_TTL_MS,
} from "../../src/hitl/admin-session.js";

const ADMIN = "correct-horse-battery-staple";
const NOW = 1_800_000_000_000;

describe("session cookie value", () => {
  it("is valid for the token that signed it, until it expires", () => {
    const v = newSessionValue(ADMIN, NOW);
    expect(sessionIsValid(v, ADMIN, NOW)).toBe(true);
    expect(sessionIsValid(v, ADMIN, NOW + SESSION_TTL_MS - 1)).toBe(true);
    expect(sessionIsValid(v, ADMIN, NOW + SESSION_TTL_MS)).toBe(false);
  });

  it("is rejected when signed with another admin token (rotating the token signs everyone out)", () => {
    expect(sessionIsValid(newSessionValue("old-token-old-token", NOW), ADMIN, NOW)).toBe(false);
  });

  it("is rejected when tampered with", () => {
    const v = newSessionValue(ADMIN, NOW);
    const [ver, expiry, sig] = v.split(".");
    // Extending the expiry invalidates the signature.
    expect(sessionIsValid(`${ver}.${Number(expiry) + 1}.${sig}`, ADMIN, NOW)).toBe(false);
    const flipped = sig!.slice(0, -1) + (sig!.endsWith("A") ? "B" : "A");
    expect(sessionIsValid(`${ver}.${expiry}.${flipped}`, ADMIN, NOW)).toBe(false);
  });

  it.each([undefined, "", "garbage", "v1.123", "v2.123.abc", `v1.${NOW}.${"x".repeat(42)}`])(
    "rejects malformed value %j",
    (v) => {
      expect(sessionIsValid(v, ADMIN, NOW)).toBe(false);
    },
  );
});

describe("Set-Cookie header", () => {
  it("is HttpOnly and SameSite=Lax, and Secure only over HTTPS", () => {
    const http = sessionCookie("v", false);
    expect(http).toContain("HttpOnly");
    expect(http).toContain("SameSite=Lax");
    expect(http).toContain("Path=/");
    expect(http).not.toContain("Secure");
    expect(sessionCookie("v", true)).toMatch(/; Secure$/);
  });

  it("clearing it sets Max-Age=0", () => {
    expect(clearedSessionCookie(true)).toMatch(/^jobhunt_admin=; .*Max-Age=0/);
  });
});

describe("readCookie", () => {
  it("finds one cookie among several", () => {
    expect(readCookie("a=1; jobhunt_admin=v1.2.3; b=2", "jobhunt_admin")).toBe("v1.2.3");
    expect(readCookie("xjobhunt_admin=nope", "jobhunt_admin")).toBeUndefined();
    expect(readCookie(undefined, "jobhunt_admin")).toBeUndefined();
  });
});

describe("failed sign-in limiter", () => {
  it("blocks an IP after 5 failures, and only that IP", () => {
    const ip = "198.51.100.1";
    for (let i = 0; i < 4; i++) recordLoginFailure(ip, NOW);
    expect(loginBlocked(ip, NOW)).toBe(false);
    recordLoginFailure(ip, NOW);
    expect(loginBlocked(ip, NOW)).toBe(true);
    expect(loginBlocked("198.51.100.2", NOW)).toBe(false);
  });

  it("unblocks after the 15-minute window", () => {
    const ip = "198.51.100.3";
    for (let i = 0; i < 5; i++) recordLoginFailure(ip, NOW);
    expect(loginBlocked(ip, NOW + 15 * 60_000 + 1)).toBe(false);
  });

  it("a successful sign-in clears the count", () => {
    const ip = "198.51.100.4";
    for (let i = 0; i < 4; i++) recordLoginFailure(ip, NOW);
    clearLoginFailures(ip);
    recordLoginFailure(ip, NOW);
    expect(loginBlocked(ip, NOW)).toBe(false);
  });
});
