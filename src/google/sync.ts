import { log } from "../log.js";
import { insertEmailMessage, knownGmailIds, markSynced } from "../repos/email-messages.js";
import { DEFAULT_MAX, type GmailMessage, type GmailSource } from "./gmail-source.js";
import { buildJobQuery, type JobQueryOptions } from "./job-query.js";

// Fetch job emails that haven't been seen before, and remember them.
// Idempotent: a second sync of the same inbox fetches and stores nothing new.

export interface SyncResult {
  query: string;
  matched: number; // ids the search returned
  alreadyStored: number;
  // The new emails, bodies included (in memory only), for the classifier.
  fresh: GmailMessage[];
}

const slog = log.child({ component: "gmail-sync" });

export async function syncJobEmails(
  source: GmailSource,
  connectionId: string,
  opts: JobQueryOptions & { max?: number } = {},
): Promise<SyncResult> {
  const query = buildJobQuery(opts);
  const ids = await source.search(query, opts.max ?? DEFAULT_MAX);
  // Skip what we already have before calling messages.get: cheaper, and it never re-reads a body.
  const known = await knownGmailIds(connectionId, ids);

  const fresh: GmailMessage[] = [];
  for (const id of ids) {
    if (known.has(id)) continue;
    const message = await source.get(id);
    // false: a sync running at the same time stored it first. Count it as seen, not fresh.
    if (await insertEmailMessage(connectionId, message)) fresh.push(message);
  }
  await markSynced(connectionId);

  slog.info({ matched: ids.length, alreadyStored: known.size, fresh: fresh.length }, "gmail sync done");
  return { query, matched: ids.length, alreadyStored: known.size, fresh };
}
