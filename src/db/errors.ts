// Is this error "the database can't be reached right now" (as opposed to a bug or bad data)?
// Those are worth a clear, retryable message to the model instead of a raw driver error.

// Node socket errors: refused, DNS failure, reset, timed out.
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"]);

// Postgres SQLSTATEs: class 08 is "connection exception"; 57P01-03 the server shutting down or
// starting; 53300 too many connections (e.g. the Supabase pooler is full).
const PG_UNAVAILABLE = /^(08...|57P0[123]|53300)$/;

// node-postgres's own messages, which carry no code.
const PG_MESSAGES = [
  "Connection terminated",
  "timeout exceeded when trying to connect",
  "Query read timeout",
  "Client has encountered a connection error",
];

export function isDbUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Connecting to "localhost" tries ::1 and 127.0.0.1: both refusals arrive as one AggregateError.
  if (err instanceof AggregateError && err.errors.length > 0 && err.errors.every(isDbUnavailable)) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && (NETWORK_CODES.has(code) || PG_UNAVAILABLE.test(code))) return true;
  return PG_MESSAGES.some((m) => err.message.includes(m));
}
