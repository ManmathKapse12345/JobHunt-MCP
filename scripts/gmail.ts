// Connect, check or disconnect the Gmail account the server reads job email from.
//   npm run gmail:connect      opens Google's consent page; read-only access
//   npm run calendar:connect   the same, plus permission to add approved events to Calendar
//   npm run gmail:status
//   npm run gmail:disconnect   revokes the access at Google and deletes the saved token
//   npm run gmail:sync [-- --days 90 --max 1000 --label jobs --no-extract --ghost-days 30]
//                              fetch new job emails, print the confirmed opportunities next
//                              to the tracker, and which ones haven't had a reply;
//                              with GEMINI_API_KEY, Gemini reads their role and dates
//   npm run gmail:propose      turn what the stored emails show into tracker changes, in one
//                              approval page (tick what to apply); no Gmail or model calls
// Uses the database in .env (your real tracker). Add --demo for the local Docker database.
import type { OpportunityMatch } from "../src/google/match.js";

if (process.argv.includes("--demo")) {
  const { TEST_ENV } = await import("../test/env.js");
  Object.assign(process.env, TEST_ENV);
}
const { closePools } = await import("../src/db/pool.js");
const { gmailAuthFromEnv, GmailNotConnected } = await import("../src/google/gmail-auth.js");
const { buildAuthUrl, CALENDAR_EVENTS, GMAIL_READONLY, newPkce, newState, OAuthError } = await import("../src/google/oauth.js");
const { calendarFromEnv } = await import("../src/google/calendar.js");
const { startLoopbackReceiver } = await import("../src/google/loopback.js");
const { env } = await import("../src/config.js");
const { getGmailConnection } = await import("../src/repos/gmail-connections.js");
const { createGmailApiSource, DEFAULT_MAX } = await import("../src/google/gmail-source.js");
const { syncJobEmails } = await import("../src/google/sync.js");
const { createGeminiExtractor, ExtractError } = await import("../src/google/extract.js");
const { DEFAULT_GHOST_AFTER_DAYS, matchOpportunities } = await import("../src/google/match.js");
const { listAllApplications } = await import("../src/repos/applications.js");
const { proposeFromMatches } = await import("../src/google/proposals.js");
const { selectTracked } = await import("../src/google/classify.js");
const { listClassifiedEmails } = await import("../src/repos/email-messages.js");
const { approveInBrowser, openBrowser } = await import("./approve.js");

const command = process.argv[2];

try {
  const auth = gmailAuthFromEnv();

  if (command === "connect") {
    // Check the database first, so a missing table is reported before Google's consent page.
    await auth.status();
    // --calendar (npm run calendar:connect): also allow adding approved events to Calendar.
    const withCalendar = process.argv.includes("--calendar");
    const pkce = newPkce();
    const state = newState();
    const receiver = await startLoopbackReceiver(state);
    const url = buildAuthUrl({
      clientId: env.GOOGLE_CLIENT_ID!,
      redirectUri: receiver.redirectUri,
      scopes: withCalendar ? [GMAIL_READONLY, CALENDAR_EVENTS] : [GMAIL_READONLY],
      state,
      codeChallenge: pkce.challenge,
    });
    console.log("Opening Google's consent page. If no browser opens, visit:\n");
    console.log(`  ${url}\n`);
    openBrowser(url);
    const code = await receiver.code;
    const { email, scopes } = await auth.completeConnect({ code, codeVerifier: pkce.verifier, redirectUri: receiver.redirectUri });
    console.log(`Connected ${email} (Gmail read-only). Granted: ${scopes.join(", ")}`);
    if (scopes.includes(CALENDAR_EVENTS)) {
      console.log("Calendar: approved interviews, assessments and deadlines can now be added (npm run gmail:propose).");
    } else if (withCalendar) {
      console.log('Calendar access was not ticked, so no events will be offered. Run calendar:connect again and tick "See, edit, share... events".');
    }
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
      env.GEMINI_API_KEY && !process.argv.includes("--no-extract")
        ? createGeminiExtractor({ apiKey: env.GEMINI_API_KEY, model: env.EXTRACT_MODEL })
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
    const ghostDays = Number(flag("--ghost-days") ?? DEFAULT_GHOST_AFTER_DAYS);
    const matches = matchOpportunities(opportunities, await listAllApplications(), { ghostAfterDays: ghostDays });
    // Sender, date and subject only; bodies are never printed (or stored).
    console.log(`\nTracked: ${opportunities.length} confirmed opportunities\n`);
    for (const { opportunity: o, ...m } of matches) {
      const what = [o.role, o.kind].filter(Boolean).join(", ");
      console.log(`  ${day(o.confirmedAt)}  ${o.organization}${what ? ` (${what})` : ""}`);
      console.log(`      tracker: ${trackerLine(m)}`);
      for (const e of o.emails) console.log(`      ${day(e.receivedAt)}  ${e.category.padEnd(10)} ${e.subject}`);
      for (const d of o.dates) {
        console.log(`      ${d.what === "event" ? `${d.category} on` : "due by"} ${d.at.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`);
      }
    }
    const quiet = matches
      .flatMap((m) => (m.reply && m.reply.state !== "replied" ? [{ ...m, reply: m.reply }] : []))
      .sort((a, b) => b.reply.daysQuiet - a.reply.daysQuiet);
    const ghosted = quiet.filter((m) => m.reply.state === "ghosted").length;
    console.log(`\nNo reply yet: ${quiet.length - ghosted} waiting, ${ghosted} ghosted (nothing for ${ghostDays}+ days)\n`);
    for (const m of quiet) {
      const role = m.application?.role ?? m.opportunity.role;
      console.log(
        `  ${String(m.reply.daysQuiet).padStart(3)} days  ${m.opportunity.organization}${role ? ` (${role})` : ""}` +
          `${m.reply.state === "ghosted" ? "  ghosted" : ""}`,
      );
    }
    if (extractor) {
      console.log(`\nRead ${r.extracted} tracked emails with ${extractor.model}${r.extractPending ? `; ${r.extractPending} left for the next sync` : ""}.`);
      if (r.extractStopped) console.log(`Stopped reading early: ${r.extractStopped}`);
    } else {
      console.log("\n(Rules only. Set GEMINI_API_KEY in .env to also read roles and interview dates.)");
    }
    console.log(`\nIgnored: ${notJob} not about an application, ${unconfirmed.length} with no confirmation email:\n`);
    for (const e of unconfirmed) console.log(`  ${day(e.receivedAt)}  ${e.category.padEnd(10)} ${e.subject}  [${e.from}]`);
  } else if (command === "propose") {
    const row = await getGmailConnection();
    if (!row) throw new GmailNotConnected("No Gmail account is connected. Run: npm run gmail:connect");
    // From what the last sync stored: no Gmail or model calls here.
    const { opportunities } = selectTracked(await listClassifiedEmails(row.id));
    const { batch, skipped, calendarNote } = await proposeFromMatches(
      matchOpportunities(opportunities, await listAllApplications()),
      { calendar: await calendarFromEnv() },
    );
    if (skipped.length) {
      console.log(`Not proposed (${skipped.length}):`);
      for (const s of skipped) console.log(`  ${s.organization}: ${s.reason}`);
      console.log();
    }
    if (calendarNote) console.log(`${calendarNote}\n`);
    if (!batch) {
      console.log("Nothing to change: your tracker already matches your job emails. (Run gmail:sync first for new ones.)");
    } else {
      await approveInBrowser(batch);
    }
  } else {
    console.log("Usage: npm run gmail:connect | gmail:status | gmail:disconnect | gmail:sync | gmail:propose");
    process.exitCode = 1;
  }
} catch (err) {
  // Expected problems (not set up, cancelled, wrong scope) get their message, not a stack.
  if (err instanceof OAuthError) console.error(`\n${err.message}`);
  else if (err instanceof ExtractError) {
    console.error(`\n${err.message}\nEmails read so far are saved; the next sync continues from there (or add --no-extract).`);
  }
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

// Where an opportunity stands in the tracker. Nothing here changes the tracker.
function trackerLine(m: Omit<OpportunityMatch, "opportunity">): string {
  if (m.match === "untracked") return `not tracked yet (emails say ${m.suggestedStatus})`;
  if (m.match === "ambiguous") {
    return `${m.candidates.length} applications could be this: ${m.candidates.map((a) => `${a.role} at ${a.company}`).join(", ")}`;
  }
  const a = m.application!;
  return `${a.role} at ${a.company}, ${a.status}${m.suggestedStatus ? `; emails say ${m.suggestedStatus} (not changed)` : ""}`;
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The value after a flag: "--days 7" → "7".
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
