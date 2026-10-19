import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Sign-in for the public approval page (HTTP mode).
//
// Why a second secret at all: the model sees every approval link (it is in the tool
// result), so on a public server a model with a web-fetch tool could open the link and
// approve its own change. Signing in with APPROVAL_ADMIN_TOKEN, which the model never
// sees, proves a human is the one clicking Approve.
//
// The session cookie is stateless: "v1.<expiry ms>.<HMAC of the first two parts>". Only a
// server that knows the admin token can make a valid one, it survives restarts, and
// changing the admin token signs everyone out.

export const SESSION_COOKIE = "jobhunt_admin";
export const SESSION_TTL_MS = 12 * 60 * 60_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function signingKey(adminToken: string): Buffer {
  // Derived, so the cookie key is never the password itself.
  return sha256(`jobhunt-admin-session:${adminToken}`);
}

function sign(payload: string, adminToken: string): string {
  return createHmac("sha256", signingKey(adminToken)).update(payload).digest("base64url");
}

export function newSessionValue(adminToken: string, now = Date.now()): string {
  const payload = `v1.${now + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload, adminToken)}`;
}

export function sessionIsValid(value: string | undefined, adminToken: string, now = Date.now()): boolean {
  const m = /^(v1\.(\d{1,15}))\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (!m) return false;
  const expected = Buffer.from(sign(m[1]!, adminToken));
  const given = Buffer.from(m[3]!);
  return expected.length === given.length && timingSafeEqual(expected, given) && Number(m[2]) > now;
}

// HttpOnly: page scripts can't read it. SameSite=Lax: sent when you open a link (top-level
// GET), but not on another site's POST, which is what would change data (CSRF).
// Secure: only over HTTPS (so not on plain http://localhost while testing).
export function sessionCookie(value: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_MS / 1000}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secure ? ["Secure"] : [])].join(
    "; ",
  );
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

// ---------- failed sign-ins: slow down guessing ----------
// In memory, per client IP: after MAX_FAILURES wrong passwords within WINDOW_MS, refuse
// sign-ins from that IP until the window passes. (One server instance, so memory is fine.)

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const failures = new Map<string, { count: number; since: number }>();

export function loginBlocked(ip: string, now = Date.now()): boolean {
  const f = failures.get(ip);
  if (f && now - f.since > WINDOW_MS) failures.delete(ip);
  return (failures.get(ip)?.count ?? 0) >= MAX_FAILURES;
}

export function recordLoginFailure(ip: string, now = Date.now()) {
  const f = failures.get(ip);
  if (!f || now - f.since > WINDOW_MS) failures.set(ip, { count: 1, since: now });
  else f.count++;
}

export function clearLoginFailures(ip: string) {
  failures.delete(ip);
}
