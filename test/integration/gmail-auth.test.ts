// Connecting Gmail against a fake Google and the real test database: what is stored,
// how tokens are refreshed, and what happens when Google says no.
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { writePool } from "../../src/db/pool.js";
import { createGmailAuth, GmailNotConnected } from "../../src/google/gmail-auth.js";
import { OAuthError, ReconnectRequired } from "../../src/google/oauth.js";
import { count, resetDb } from "../helpers/db.js";
import { fakeGoogle } from "../helpers/fake-google.js";

const key = randomBytes(32);
const client = { clientId: "abc.apps.googleusercontent.com", clientSecret: "secret" };
const connect = { code: "4/one-time-code", codeVerifier: "v".repeat(43), redirectUri: "http://127.0.0.1:5555/callback" };

let google: ReturnType<typeof fakeGoogle>;
let clock: number;
const makeAuth = () => createGmailAuth({ client, key, fetch: google.fetch, now: () => clock });

beforeEach(async () => {
  await resetDb();
  google = fakeGoogle("Me@Gmail.com");
  clock = Date.UTC(2026, 9, 20, 12);
});

describe("connect", () => {
  it("stores the account with the refresh token encrypted, never in plain text", async () => {
    const auth = makeAuth();
    expect(await auth.completeConnect(connect)).toEqual({
      email: "Me@Gmail.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });

    const { rows } = await writePool.query("select * from gmail_connections");
    expect(rows).toHaveLength(1);
    expect(rows[0].refresh_token_enc).toMatch(/^v1\./);
    expect(JSON.stringify(rows[0])).not.toContain("1//refresh-token-from-google");

    // The code exchange sent the PKCE verifier and the same redirect URI.
    expect(google.tokenCalls()[0]!.body).toMatchObject({
      grant_type: "authorization_code",
      code: connect.code,
      code_verifier: connect.codeVerifier,
      redirect_uri: connect.redirectUri,
    });
  });

  it("refuses when the Gmail permission was unticked, stores nothing, and revokes what was granted", async () => {
    google.next.grantedScope = "openid";
    await expect(makeAuth().completeConnect(connect)).rejects.toThrow(/Gmail access was not granted/);
    expect(await count("gmail_connections")).toBe(0);
    expect(google.calls.some((c) => c.url.endsWith("/revoke"))).toBe(true);
  });

  it("refuses a used or expired code (invalid_grant)", async () => {
    google.next.tokenError = "invalid_grant";
    await expect(makeAuth().completeConnect(connect)).rejects.toBeInstanceOf(ReconnectRequired);
    expect(await count("gmail_connections")).toBe(0);
  });

  it("reconnecting the same account replaces its token instead of adding a row", async () => {
    await makeAuth().completeConnect(connect);
    google.next.refreshToken = "1//a-newer-refresh-token";
    await makeAuth().completeConnect(connect);
    expect(await count("gmail_connections")).toBe(1);
  });
});

describe("access tokens", () => {
  it("reuses the access token while it is valid, then refreshes it with the stored refresh token", async () => {
    const auth = makeAuth();
    await auth.completeConnect(connect);
    const first = await auth.accessToken();
    expect(await auth.accessToken()).toEqual(first); // cached: no new token request
    expect(google.tokenCalls()).toHaveLength(1);

    clock += 59 * 60_000; // less than a minute left: refresh
    const second = await auth.accessToken();
    expect(second.token).not.toBe(first.token);
    expect(google.tokenCalls().at(-1)!.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "1//refresh-token-from-google", // decrypted from the database
    });
  });

  it("a new process (empty cache) refreshes from the database", async () => {
    await makeAuth().completeConnect(connect);
    const { token, email } = await makeAuth().accessToken();
    expect(token).toMatch(/^ya29\./);
    expect(email).toBe("Me@Gmail.com");
  });

  it("says to reconnect when Google revoked the grant (or the 7-day testing token expired)", async () => {
    await makeAuth().completeConnect(connect);
    google.next.tokenError = "invalid_grant";
    await expect(makeAuth().accessToken()).rejects.toThrow(/no longer accepts.*npm run gmail:connect/);
  });

  it("says how to connect when nothing is connected", async () => {
    await expect(makeAuth().accessToken()).rejects.toBeInstanceOf(GmailNotConnected);
  });

  it("a different encryption key can't use the stored token", async () => {
    await makeAuth().completeConnect(connect);
    const other = createGmailAuth({ client, key: randomBytes(32), fetch: google.fetch });
    await expect(other.accessToken()).rejects.toThrow(/could not decrypt/);
  });
});

describe("disconnect", () => {
  it("revokes the refresh token at Google and deletes it here", async () => {
    const auth = makeAuth();
    await auth.completeConnect(connect);
    expect(await auth.disconnect()).toEqual({ email: "Me@Gmail.com", revoked: true });
    expect(google.calls.at(-1)).toMatchObject({ url: "https://oauth2.googleapis.com/revoke", body: { token: "1//refresh-token-from-google" } });
    expect(await count("gmail_connections")).toBe(0);
    await expect(auth.accessToken()).rejects.toBeInstanceOf(GmailNotConnected);
  });

  it("still deletes the local token when Google can't be reached", async () => {
    const auth = makeAuth();
    await auth.completeConnect(connect);
    google.next.revokeOk = false;
    expect(await auth.disconnect()).toMatchObject({ revoked: false });
    expect(await count("gmail_connections")).toBe(0);
  });

  it("with nothing connected, does nothing", async () => {
    expect(await makeAuth().disconnect()).toBeUndefined();
  });
});

it("all expected failures are OAuthErrors (scripts and tools show their message, not a stack)", () => {
  expect(new ReconnectRequired("x")).toBeInstanceOf(OAuthError);
  expect(new GmailNotConnected("x")).toBeInstanceOf(OAuthError);
});
