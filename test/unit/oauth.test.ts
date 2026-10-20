import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthUrl, GMAIL_READONLY, newPkce, newState } from "../../src/google/oauth.js";

describe("PKCE", () => {
  it("challenge = base64url(SHA-256(verifier)); verifier is 43 chars and unique", () => {
    const a = newPkce();
    expect(a.verifier).toMatch(/^[\w-]{43}$/);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(newPkce().verifier).not.toBe(a.verifier);
  });

  it("state values are random", () => {
    expect(newState()).not.toBe(newState());
  });
});

describe("consent URL", () => {
  const url = new URL(
    buildAuthUrl({
      clientId: "abc.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1:5555/callback",
      scopes: [GMAIL_READONLY],
      state: "st",
      codeChallenge: "ch",
    }),
  );
  const p = Object.fromEntries(url.searchParams);

  it("goes to Google's v2 endpoint", () => {
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });

  it("asks for read-only Gmail and nothing else", () => {
    expect(p.scope).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("uses PKCE S256, state, and asks for a refresh token", () => {
    expect(p).toMatchObject({
      response_type: "code",
      code_challenge: "ch",
      code_challenge_method: "S256",
      state: "st",
      access_type: "offline",
      prompt: "consent",
      redirect_uri: "http://127.0.0.1:5555/callback",
    });
  });
});
