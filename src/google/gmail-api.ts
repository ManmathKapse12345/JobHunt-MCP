import { OAuthError, ReconnectRequired, type Fetch } from "./oauth.js";

// The Gmail REST API, plain fetch. Only what the server uses; all read-only.
// https://developers.google.com/gmail/api/reference/rest

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  historyId: string;
}

// Which account the token belongs to. Needs only gmail.readonly (no extra "email" scope).
export function getProfile(fetchFn: Fetch, accessToken: string): Promise<GmailProfile> {
  return gmailGet<GmailProfile>(fetchFn, accessToken, "/profile");
}

async function gmailGet<T>(fetchFn: Fetch, accessToken: string, path: string): Promise<T> {
  const res = await fetchFn(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) throw new ReconnectRequired("Gmail refused the access token; connect Gmail again.");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new OAuthError(`Gmail API ${path}: ${res.status}${body.error?.message ? ` (${body.error.message})` : ""}`);
  }
  return (await res.json()) as T;
}
