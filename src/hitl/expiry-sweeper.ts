import { isDbUnavailable } from "../db/errors.js";
import { log } from "../log.js";
import { expireOldPendingActions } from "../repos/pending-actions.js";

// Once a minute, mark approval links past their 15 minutes as expired. Expired links are
// already refused when someone clicks them; this keeps the table truthful between clicks.
// A failed sweep (database down) is logged and retried next minute; it never crashes the server.
export function startExpirySweeper(intervalMs = 60_000): () => void {
  const sweep = async () => {
    try {
      const expired = await expireOldPendingActions();
      if (expired > 0) log.info({ component: "approvals", expired }, "expired approval links");
    } catch (err) {
      log.warn({ component: "approvals", err, dbUnavailable: isDbUnavailable(err) }, "expiry sweep failed");
    }
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref(); // never keeps the process alive on its own
  return () => clearInterval(timer);
}
