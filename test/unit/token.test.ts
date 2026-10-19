import { describe, expect, it } from "vitest";
import { hashToken, newToken, secretEquals, tokenMatches } from "../../src/hitl/token.js";

describe("approval link tokens", () => {
  it("are URL-safe, 256-bit and unique", () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes in base64url
    expect(newToken()).not.toBe(a);
  });

  it("are stored as a SHA-256 hex hash, never as themselves", () => {
    const t = newToken();
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(hashToken(t)).toBe(h);
  });

  it("match only their own hash", () => {
    const t = newToken();
    expect(tokenMatches(t, hashToken(t))).toBe(true);
    expect(tokenMatches(newToken(), hashToken(t))).toBe(false);
    expect(tokenMatches(t, "not-a-hash")).toBe(false);
  });
});

describe("secretEquals", () => {
  it("compares exactly, whatever the lengths", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    expect(secretEquals("abc", "abcd")).toBe(false);
    expect(secretEquals("", "abc")).toBe(false);
  });
});
