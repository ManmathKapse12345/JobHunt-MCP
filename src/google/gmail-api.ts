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

// ---------- messages ----------

export interface MessageList {
  messages?: Array<{ id: string; threadId: string }>; // absent when nothing matches
  nextPageToken?: string;
}

// One page of ids matching a Gmail search ("from:x newer_than:30d"), newest first.
export function listMessages(
  fetchFn: Fetch,
  accessToken: string,
  opts: { q: string; maxResults: number; pageToken?: string },
): Promise<MessageList> {
  const params = new URLSearchParams({ q: opts.q, maxResults: String(opts.maxResults) });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  return gmailGet<MessageList>(fetchFn, accessToken, `/messages?${params}`);
}

// A MIME part. Bodies are base64url; multipart messages nest parts inside parts.
export interface MessagePart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; data?: string };
  parts?: MessagePart[];
}

export interface RawMessage {
  id: string;
  threadId: string;
  internalDate: string; // ms since epoch, as a string
  payload: MessagePart;
}

export function getMessage(fetchFn: Fetch, accessToken: string, id: string): Promise<RawMessage> {
  return gmailGet<RawMessage>(fetchFn, accessToken, `/messages/${encodeURIComponent(id)}?format=full`);
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
