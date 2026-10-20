// Connect, check or disconnect the Gmail account the server reads job email from.
//   npm run gmail:connect      opens Google's consent page; read-only access
//   npm run gmail:status
//   npm run gmail:disconnect   revokes the access at Google and deletes the saved token
//   npm run gmail:sync [-- --days 90 --max 1000 --label jobs --no-extract]
//                              fetch new job emails, print the confirmed opportunities;
//                              with ANTHROPIC_API_KEY, Claude reads their role and dates
// Uses the database in .env (your real tracker). Add --demo for the local Docker database.
import { spawn } from "node:child_process";

if (process.argv.includes("--demo")) {
  const { TEST_ENV } = await import("../test/env.js");
  Object.assign(process.env, TEST_ENV);
}
const { closePools } = await import("../src/db/pool.js");
const { gmailAuthFromEnv, GmailNotConnected } = await import("../src/google/gmail-auth.js");
const { buildAuthUrl, GMAIL_READONLY, newPkce, newState, OAuthError } = await import("../src/google/oauth.js");
const { startLoopbackReceiver } = await import("../src/google/loopback.js");
const { env } = await import("../src/config.js");
const { getGmailConnection } = await import("../src/repos/gmail-connections.js");
const { createGmailApiSource, DEFAULT_MAX } = await import("../src/google/gmail-source.js");
const { syncJobEmails } = await import("../src/google/sync.js");
const { createClaudeExtractor, ExtractError } = await import("../src/google/extract.js");

const command = process.argv[2];

try {
  const auth = gmailAuthFromEnv();

  if (command === "connect") {
    // Check the database first, so a missing table is reported before Google's consent page.
    await auth.status();
    const pkce = newPkce();
    const state = newState();
    const receiver = await startLoopbackReceiver(state);
    const url = buildAuthUrl({
      clientId: env.GOOGLE_CLIENT_ID!,
      redirectUri: receiver.redirectUri,
      scopes: [GMAIL_READONLY],
      state,
      codeChallenge: pkce.challenge,
    });
    console.log("Opening Google's consent page. If no browser opens, visit:\n");
    console.log(`  ${url}\n`);
    openBrowser(url);
    const code = await receiver.code;
    const { email, scopes } = await auth.completeConnect({ code, codeVerifier: pkce.verifier, redirectUri: receiver.redirectUri });
    console.log(`Connected ${email} (read-only). Granted: ${scopes.join(", ")}`);
  } else if (command === "status") {
    const s = await auth.status();
    console.log(s.connected ? `Connected: ${s.email} since ${s.connectedAt.toISOString()}\nScopes: ${s.scopes.join(", ")}` : "No Gmail account connected.");
  } else if (command === "disconnect") {
    const r = await auth.disconnect();
    console.log(r ? `Disconnected ${r.email}${r.revoked ? " (access revoked at Google)" : " (could not reach Google; local token deleted)"}.` : "No Gmail account connected.");
  } else if (command === "sync") {
    const row = await getGmailConnection();
    if (!row) throw new GmailNotConnected("No Gmail account is connected. Run: npm run gmail:connect");
    const days = flag("--days");
    const max = flag("--max");
    const extractor =
      env.ANTHROPIC_API_KEY && !process.argv.includes("--no-extract")
        ? createClaudeExtractor({ apiKey: env.ANTHROPIC_API_KEY, model: env.EXTRACT_MODEL })
        : undefined;
    const r = await syncJobEmails(createGmailApiSource(auth), row.id, {
      newerThanDays: days === undefined ? undefined : Number(days),
      label: flag("--label"),
      max: max === undefined ? undefined : Number(max),
      extractor,
    });
    const { opportunities, unconfirmed, notJob } = r.tracking;
    console.log(`Searched ${row.email}: ${r.matched} matched, ${r.alreadyStored} already stored, ${r.fresh.length} new.`);
    if (r.matched === (Number(max) || DEFAULT_MAX)) {
      console.log(`(Stopped at ${r.matched}; older matches weren't read. Raise it with -- --max 1000.)`);
    }
    // Sender, date and subject only; bodies are never printed (or stored).
    console.log(`\nTracked: ${opportunities.length} confirmed opportunities\n`);
    for (const o of opportunities) {
      const what = [o.role, o.kind].filter(Boolean).join(", ");
      console.log(`  ${day(o.confirmedAt)}  ${o.organization}${what ? ` (${what})` : ""}`);
      for (const e of o.emails) console.log(`      ${day(e.receivedAt)}  ${e.category.padEnd(10)} ${e.subject}`);
      for (const d of o.dates) {
        console.log(`      ${d.what === "event" ? `${d.category} on` : "due by"} ${d.at.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`);
      }
    }
    if (extractor) {
      console.log(`\nRead ${r.extracted} tracked emails with ${extractor.model}${r.extractPending ? `; ${r.extractPending} left for the next sync` : ""}.`);
    } else {
      console.log("\n(Rules only. Set ANTHROPIC_API_KEY in .env to also read roles and interview dates.)");
    }
    console.log(`\nIgnored: ${notJob} not about an application, ${unconfirmed.length} with no confirmation email:\n`);
    for (const e of unconfirmed) console.log(`  ${day(e.receivedAt)}  ${e.category.padEnd(10)} ${e.subject}  [${e.from}]`);
  } else {
    console.log("Usage: npm run gmail:connect | gmail:status | gmail:disconnect | gmail:sync");
    process.exitCode = 1;
  }
} catch (err) {
  // Expected problems (not set up, cancelled, wrong scope) get their message, not a stack.
  if (err instanceof OAuthError || err instanceof ExtractError) console.error(`\n${err.message}`);
  else if ((err as { code?: string }).code === "42P01") {
    // pg's message names the table: 'relation "email_messages" does not exist'.
    const table = /relation "([^"]+)"/.exec((err as Error).message)?.[1] ?? "gmail_connections";
    const file = table === "email_messages" ? "006_email_messages.sql" : "005_gmail_connections.sql";
    console.error(
      `\nThe ${table} table doesn't exist in this database yet.\n` +
        `Run supabase/migrations/${file} (Supabase: SQL editor), then try again.`,
    );
  } else if ((err as { code?: string }).code === "42703") {
    // A column added by a later migration: 007 (category, ...) or 008 (role, extracted_at, ...).
    const file = /\b(role|extracted_kind|event_at|deadline_at|extracted_at|extracted_by)\b/.test((err as Error).message)
      ? "008_email_extraction.sql"
      : "007_email_classification.sql";
    console.error(
      `\n${(err as Error).message}: the database is missing a migration.\n` +
        `Run supabase/migrations/${file} (Supabase: SQL editor), then try again.`,
    );
  } else console.error(err);
  process.exitCode = 1;
} finally {
  await closePools();
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The value after a flag: "--days 7" → "7".
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

// Best effort; the URL is printed anyway. rundll32 avoids cmd.exe, which would cut the
// URL at its first "&".
function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
