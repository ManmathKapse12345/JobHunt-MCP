import type { GmailAuth } from "./gmail-auth.js";
import { getMessage, listMessages, type MessagePart, type RawMessage } from "./gmail-api.js";
import type { Fetch } from "./oauth.js";

// Where the sync gets email from. The real one calls the Gmail API; tests use a fake
// (test/helpers/fake-gmail-source.ts) that serves fixture emails.

// One email as the rest of the server sees it. `text` (the body) lives in memory only:
// the classifier reads it, the database never stores it.
export interface GmailMessage {
  id: string;
  threadId: string;
  from: string; // the raw From header, e.g. "LinkedIn <jobs-noreply@linkedin.com>"
  subject: string;
  receivedAt: Date;
  text: string;
}

export interface GmailSource {
  // Ids of messages matching a Gmail search, newest first, at most `max` of them.
  search(query: string, max?: number): Promise<string[]>;
  get(id: string): Promise<GmailMessage>;
}

export const DEFAULT_MAX = 100;
const PAGE_SIZE = 100; // Gmail allows up to 500 per page

export function createGmailApiSource(auth: Pick<GmailAuth, "accessToken">, fetchFn: Fetch = fetch): GmailSource {
  return {
    async search(query, max = DEFAULT_MAX) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const { token } = await auth.accessToken();
        const page = await listMessages(fetchFn, token, {
          q: query,
          maxResults: Math.min(PAGE_SIZE, max - ids.length),
          pageToken,
        });
        for (const m of page.messages ?? []) ids.push(m.id);
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);
      return ids.slice(0, max);
    },

    async get(id) {
      const { token } = await auth.accessToken();
      return parseMessage(await getMessage(fetchFn, token, id));
    },
  };
}

// ---------- parsing Gmail's format=full ----------

export function parseMessage(raw: RawMessage): GmailMessage {
  return {
    id: raw.id,
    threadId: raw.threadId,
    from: header(raw.payload, "From"),
    subject: header(raw.payload, "Subject"),
    receivedAt: new Date(Number(raw.internalDate)),
    text: bodyText(raw.payload),
  };
}

function header(part: MessagePart, name: string): string {
  const lower = name.toLowerCase();
  return part.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

// The text/plain part if there is one, else the text/html part stripped of its tags.
export function bodyText(payload: MessagePart): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return decode(plain);
  const html = findPart(payload, "text/html");
  return html ? htmlToText(decode(html)) : "";
}

// Depth-first, so the first match in the message's own order wins.
function findPart(part: MessagePart, mimeType: string): MessagePart | undefined {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function decode(part: MessagePart): string {
  return Buffer.from(part.body?.data ?? "", "base64url").toString("utf8");
}

// Good enough for classifying job emails; not a general HTML renderer.
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&") // last, so "&amp;lt;" becomes "&lt;", not "<"
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
