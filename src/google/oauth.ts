import { createHash, randomBytes } from "node:crypto";

// Google OAuth 2.0, authorization-code flow with PKCE, for an installed ("Desktop app")
// client. Plain fetch, no SDK: every step is visible.
//
//   1. buildAuthUrl()        send the user's browser to Google's consent page
//   2. Google redirects to our loopback URL with ?code=...&state=...
//   3. exchangeCode()        trade the one-time code (+ PKCE verifier) for tokens
//   4. refreshAccessToken()  later: the refresh token buys a new 1-hour access token
//   5. revokeToken()         disconnect: Google forgets the grant
//
// https://developers.google.com/identity/protocols/oauth2/native-app

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// Read-only: the server can never send, delete or change mail.
export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export type Fetch = typeof fetch;

// Expected failures, worded for the person at the keyboard.
export class OAuthError extends Error {}
// The stored grant no longer works (revoked, expired, password changed): connect again.
export class ReconnectRequired extends OAuthError {}

// ---------- PKCE (RFC 7636) and state ----------
// The verifier stays with us; Google only sees its SHA-256 (the challenge). Someone who
// intercepts the redirect gets the code, but can't redeem it without the verifier.
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars, within RFC 7636's 43-128
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// Ties the redirect to the request we started: a forged redirect (login CSRF) won't match.
export function newState(): string {
  return randomBytes(16).toString("base64url");
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scopes.join(" "),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // ...every time, even if this app was approved before
    include_granted_scopes: "true", // so adding Calendar later keeps Gmail (incremental consent)
    ...(opts.loginHint && { login_hint: opts.loginHint }),
  }).toString();
  return url.toString();
}

// ---------- token endpoint ----------

export interface Tokens {
  accessToken: string;
  expiresAt: number; // ms epoch
  refreshToken?: string; // only on the first exchange (thanks to prompt=consent: always there)
  scopes: string[];
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(fetchFn: Fetch, body: Record<string, string>, now: number): Promise<Tokens> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // invalid_grant: the code or refresh token is expired, used or revoked.
    if (json.error === "invalid_grant") throw new ReconnectRequired("Google no longer accepts this grant; connect Gmail again.");
    throw new OAuthError(`Google token endpoint: ${json.error ?? res.status}${json.error_description ? ` (${json.error_description})` : ""}`);
  }
  return {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
    refreshToken: json.refresh_token,
    scopes: (json.scope ?? "").split(" ").filter(Boolean),
  };
}

export function exchangeCode(
  fetchFn: Fetch,
  client: OAuthClient,
  opts: { code: string; codeVerifier: string; redirectUri: string },
  now = Date.now(),
): Promise<Tokens> {
  return tokenRequest(
    fetchFn,
    {
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    now,
  );
}

export function refreshAccessToken(fetchFn: Fetch, client: OAuthClient, refreshToken: string, now = Date.now()): Promise<Tokens> {
  return tokenRequest(
    fetchFn,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret },
    now,
  );
}

// Best effort: an already-revoked token answers 400, which is fine.
export async function revokeToken(fetchFn: Fetch, token: string): Promise<boolean> {
  const res = await fetchFn(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  return res.ok;
}
