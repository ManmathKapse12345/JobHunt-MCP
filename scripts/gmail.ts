// Connect, check or disconnect the Gmail account the server reads job email from.
//   npm run gmail:connect      opens Google's consent page; read-only access
//   npm run gmail:status
//   npm run gmail:disconnect   revokes the access at Google and deletes the saved token
// Uses the database in .env (your real tracker). Add --demo for the local Docker database.
import { spawn } from "node:child_process";

if (process.argv.includes("--demo")) {
  const { TEST_ENV } = await import("../test/env.js");
  Object.assign(process.env, TEST_ENV);
}
const { closePools } = await import("../src/db/pool.js");
const { gmailAuthFromEnv } = await import("../src/google/gmail-auth.js");
const { buildAuthUrl, GMAIL_READONLY, newPkce, newState, OAuthError } = await import("../src/google/oauth.js");
const { startLoopbackReceiver } = await import("../src/google/loopback.js");
const { env } = await import("../src/config.js");

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
  } else {
    console.log("Usage: npm run gmail:connect | gmail:status | gmail:disconnect");
    process.exitCode = 1;
  }
} catch (err) {
  // Expected problems (not set up, cancelled, wrong scope) get their message, not a stack.
  if (err instanceof OAuthError) console.error(`\n${err.message}`);
  else if ((err as { code?: string }).code === "42P01") {
    console.error(
      "\nThe gmail_connections table doesn't exist in this database yet.\n" +
        "Run supabase/migrations/005_gmail_connections.sql (Supabase: SQL editor), then try again.",
    );
  } else console.error(err);
  process.exitCode = 1;
} finally {
  await closePools();
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
