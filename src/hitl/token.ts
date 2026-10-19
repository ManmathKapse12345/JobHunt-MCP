import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// The secret in an approval link: 32 random bytes, URL-safe.
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// Only this hash is stored, like a password hash: the database alone cannot approve anything.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Constant-time compare of two secrets (bearer token, admin token). Hashing first makes
// both sides the same length, which timingSafeEqual requires.
export function secretEquals(given: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

// Constant-time compare, so response timing does not leak how much of a guess was right.
export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
