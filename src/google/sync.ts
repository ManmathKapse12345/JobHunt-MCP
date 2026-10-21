import { log } from "../log.js";
import {
  classifyStoredEmails,
  insertEmailMessage,
  knownGmailIds,
  listClassifiedEmails,
  markSynced,
  saveExtraction,
} from "../repos/email-messages.js";
import { selectTracked, type TrackingResult } from "./classify.js";
import { type Extraction, ExtractError, type Extractor } from "./extract.js";
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
  extracted: number; // tracked emails the extractor read this time
  extractPending: number; // left for the next sync (over maxExtract, or extraction stopped)
  extractStopped?: string; // why extraction stopped early, if it did
}

export interface SyncOptions extends JobQueryOptions {
  max?: number;
  // Without one, the sync is rules only.
  extractor?: Extractor;
  // At most this many model calls per sync (cost cap). Default 100.
  maxExtract?: number;
}

const DEFAULT_MAX_EXTRACT = 100;

const slog = log.child({ component: "gmail-sync" });
// messages.get costs 5 quota units; a few at a time keeps a big first sync near Gmail's
// per-user limit rather than far over it. The source retries when it's hit anyway.
const PARALLEL_GETS = 4;

export async function syncJobEmails(
  source: GmailSource,
  connectionId: string,
  opts: SyncOptions = {},
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
  let tracking = selectTracked(await listClassifiedEmails(connectionId));

  // Read role and dates from tracked emails not read yet. Only these go to the model:
  // never an email the gate ignored. Older ones are fetched again (their text was never kept).
  let extracted = 0;
  let extractPending = 0;
  let extractStopped: string | undefined;
  if (opts.extractor) {
    const freshById = new Map(fresh.map((m) => [m.id, m]));
    const pending = tracking.opportunities.flatMap((o) => o.emails).filter((e) => !e.extracted);
    for (const e of pending.slice(0, opts.maxExtract ?? DEFAULT_MAX_EXTRACT)) {
      const text = freshById.get(e.id)?.text ?? (await source.get(e.id)).text;
      let x: Extraction;
      try {
        x = await opts.extractor.extract({ ...e, text });
      } catch (err) {
        // Quota used up, bad key, API down: the rest of the sync still stands, and the
        // emails not read yet are read next time.
        if (!(err instanceof ExtractError)) throw err;
        extractStopped = err.message;
        break;
      }
      await saveExtraction(connectionId, e.id, x, opts.extractor.model);
      extracted++;
    }
    extractPending = pending.length - extracted;
    if (extracted > 0) tracking = selectTracked(await listClassifiedEmails(connectionId));
  }
  await markSynced(connectionId);

  slog.info(
    {
      matched: ids.length,
      alreadyStored: known.size,
      fresh: fresh.length,
      reclassified,
      opportunities: tracking.opportunities.length,
      unconfirmed: tracking.unconfirmed.length,
      extracted,
      extractPending,
      extractStopped,
    },
    "gmail sync done",
  );
  return { query, matched: ids.length, alreadyStored: known.size, fresh, tracking, extracted, extractPending, extractStopped };
}
