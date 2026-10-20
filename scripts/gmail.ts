// Connect, check or disconnect the Gmail account the server reads job email from.
//   npm run gmail:connect      opens Google's consent page; read-only access
//   npm run gmail:status
//   npm run gmail:disconnect   revokes the access at Google and deletes the saved token
//   npm run gmail:sync [-- --days 30 --label jobs]   fetch new job emails, print what was found
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
const { createGmailApiSource } = await import("../src/google/gmail-source.js");
const { syncJobEmails } = await import("../src/google/sync.js");

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
    const r = await syncJobEmails(createGmailApiSource(auth), row.id, {
      newerThanDays: days === undefined ? undefined : Number(days),
      label: flag("--label"),
    });
    console.log(`Searched ${row.email}: ${r.query}\n`);
    console.log(`${r.matched} matched, ${r.alreadyStored} already stored, ${r.fresh.length} new.\n`);
    // Sender, date and subject only; bodies are never printed (or stored).
    for (const m of r.fresh) {
      console.log(`  ${m.receivedAt.toISOString().slice(0, 10)}  ${m.from}\n              ${m.subject}`);
    }
  } else {
    console.log("Usage: npm run gmail:connect | gmail:status | gmail:disconnect | gmail:sync");
    process.exitCode = 1;
  }
} catch (err) {
  // Expected problems (not set up, cancelled, wrong scope) get their message, not a stack.
  if (err instanceof OAuthError) console.error(`\n${err.message}`);
  else if ((err as { code?: string }).code === "42P01") {
    console.error(
      "\nA Gmail table doesn't exist in this database yet.\n" +
        "Run supabase/migrations/005_gmail_connections.sql and 006_email_messages.sql (Supabase: SQL editor), then try again.",
    );
  } else console.error(err);
  process.exitCode = 1;
} finally {
  await closePools();
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
