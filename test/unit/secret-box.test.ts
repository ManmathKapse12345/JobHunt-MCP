import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecryptError, open, seal } from "../../src/crypto/secret-box.js";

const key = randomBytes(32);
const SECRET = "1//0g-refresh-token-example";

describe("secret box (AES-256-GCM)", () => {
  it("round-trips, and the stored form never contains the secret", () => {
    const sealed = seal(SECRET, key, "ctx");
    expect(sealed).toMatch(/^v1\.[\w-]{16}\.[\w-]+$/);
    expect(sealed).not.toContain(SECRET);
    expect(open(sealed, key, "ctx")).toBe(SECRET);
  });

  it("uses a fresh IV every time: same secret, different ciphertext", () => {
    expect(seal(SECRET, key, "ctx")).not.toBe(seal(SECRET, key, "ctx"));
  });

  it("refuses the wrong key", () => {
    expect(() => open(seal(SECRET, key, "ctx"), randomBytes(32), "ctx")).toThrow(DecryptError);
  });

  it("refuses the wrong context: a token moved to another account's row won't decrypt", () => {
    expect(() => open(seal(SECRET, key, "gmail_connections:a@x.com"), key, "gmail_connections:b@x.com")).toThrow(DecryptError);
  });

  it("refuses tampered data (GCM authenticates it)", () => {
    const sealed = seal(SECRET, key, "ctx");
    const body = sealed.split(".")[2]!;
    const flipped = body.slice(0, 5) + (body[5] === "A" ? "B" : "A") + body.slice(6);
    expect(() => open(sealed.replace(body, flipped), key, "ctx")).toThrow(DecryptError);
  });

  it.each(["", "v2.aaa.bbb", "v1.short.x", "not-sealed"])("refuses malformed value %j", (v) => {
    expect(() => open(v, key, "ctx")).toThrow(DecryptError);
  });

  it("insists on a 32-byte key", () => {
    expect(() => seal(SECRET, randomBytes(16), "ctx")).toThrow(/32 bytes/);
  });
});
