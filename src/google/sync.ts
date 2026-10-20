import { log } from "../log.js";
import {
  classifyStoredEmails,
  insertEmailMessage,
  knownGmailIds,
  listClassifiedEmails,
  markSynced,
} from "../repos/email-messages.js";
import { selectTracked, type TrackingResult } from "./classify.js";
import { DEFAULT_MAX, type GmailMessage, type GmailSource } from "./gmail-source.js";
import { buildJobQuery, type JobQueryOptions } from "./job-query.js";

// Fetch job emails that haven't been seen before, remember them, and work out which
// opportunities are confirmed (classify.ts). Idempotent: a second sync of the same inbox
// fetches and stores nothing new.

export interface SyncResult {
  query: string;
  matched: number; // ids the search returned
  alreadyStored: number;
  // The new emails, bodies included (in memory only), for the extractor (Day 20).
  fresh: GmailMessage[];
  // Over everything stored for the account, not just this sync.
  tracking: TrackingResult;
}

const slog = log.child({ component: "gmail-sync" });
// messages.get costs 5 quota units; a few at a time keeps a big first sync near Gmail's
// per-user limit rather than far over it. The source retries when it's hit anyway.
const PARALLEL_GETS = 4;

export async function syncJobEmails(
  source: GmailSource,
  connectionId: string,
  opts: JobQueryOptions & { max?: number } = {},
): Promise<SyncResult> {
  const query = buildJobQuery(opts);
  const ids = await source.search(query, opts.max ?? DEFAULT_MAX);
  // Skip what we already have before calling messages.get: cheaper, and it never re-reads a body.
  const known = await knownGmailIds(connectionId, ids);
  const toFetch = ids.filter((id) => !known.has(id));

  const fresh: GmailMessage[] = [];
  for (let i = 0; i < toFetch.length; i += PARALLEL_GETS) {
    const batch = await Promise.all(toFetch.slice(i, i + PARALLEL_GETS).map((id) => source.get(id)));
    for (const message of batch) {
      // false: a sync running at the same time stored it first. Count it as seen, not fresh.
      if (await insertEmailMessage(connectionId, message)) fresh.push(message);
    }
  }
  // All stored emails, not only the new ones: rules may have changed since the last sync.
  const reclassified = await classifyStoredEmails(connectionId);
  const tracking = selectTracked(await listClassifiedEmails(connectionId));
  await markSynced(connectionId);

  slog.info(
    {
      matched: ids.length,
      alreadyStored: known.size,
      fresh: fresh.length,
      reclassified,
      opportunities: tracking.opportunities.length,
      unconfirmed: tracking.unconfirmed.length,
    },
    "gmail sync done",
  );
  return { query, matched: ids.length, alreadyStored: known.size, fresh, tracking };
}
