# Connect Gmail (read-only)

The server can read your job-related email to propose tracker updates. It asks Google for **read-only** access (`gmail.readonly`): it can never send, delete or change mail. This takes about 10 minutes, once.

## 1. Create a Google Cloud project and enable the Gmail API

1. Open <https://console.cloud.google.com/> and create a project, e.g. `jobhunt-mcp` (top bar → project picker → **New project**).
2. **APIs & Services → Library**, search for **Gmail API**, click **Enable**.

## 2. Set up the consent screen

In **Google Auth Platform** (older consoles: **APIs & Services → OAuth consent screen**):

1. **Branding / Get started:** app name `jobhunt-mcp`, your email as support and developer contact.
2. **Audience:** user type **External**. Leave the publishing status on **Testing**.
3. **Audience → Test users → Add users:** add the Gmail address you job-hunt with. In Testing mode only listed test users can connect.

You don't need to submit anything for verification: as a test user of your own app you can use it right away.

## 3. Create the OAuth client

1. **Clients → Create client** (older: **Credentials → Create credentials → OAuth client ID**).
2. Application type: **Desktop app**. Name: `jobhunt-mcp local`. **Create**.
3. Copy the **Client ID** and **Client secret**.

"Desktop app" lets the connect script receive Google's answer on `http://127.0.0.1:<any port>`, so no redirect URL needs to be registered.

## 4. Add three lines to `.env`

```bash
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
TOKEN_ENCRYPTION_KEY=<output of the command below>
```

Make the encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

It encrypts the saved Google token in the database. Keep it only in `.env` (never in git). If you lose or change it, just connect again.

## 5. Create the tables and connect

1. Run these in the Supabase SQL editor, in order: [`005_gmail_connections.sql`](../supabase/migrations/005_gmail_connections.sql), [`006_email_messages.sql`](../supabase/migrations/006_email_messages.sql), [`007_email_classification.sql`](../supabase/migrations/007_email_classification.sql), [`008_email_extraction.sql`](../supabase/migrations/008_email_extraction.sql).
2. Run:

   ```bash
   npm run gmail:connect
   ```

   Your browser opens Google's page. Pick your account. Google warns **"Google hasn't verified this app"**: that's expected for your own app in Testing mode; click **Continue**. Tick **"View your email messages and settings"** and continue.
3. The terminal prints `Connected you@gmail.com (read-only)`. Check any time with `npm run gmail:status`.

To try it without touching your real tracker, add `--demo` (uses the local Docker database): `npm run gmail:connect -- --demo`.

## 6. Sync

```bash
npm run gmail:sync -- --days 180 --max 1000   # first time: go far back
npm run gmail:sync                            # after that: the last 30 days
```

It prints the confirmed opportunities and what it ignored. A job, internship, competition or hackathon is tracked only when its confirmation email is there, from any job site or company ("Thank you for applying", "Your application was sent to ...", "Indeed Application: ...", "Thanks for registering"); interviews, assessments and rejections are tracked only for those. Emails with no confirmation behind them (ads, "selection" emails for things you never applied to) are ignored. Only sender, subject and date are stored, never the email text.

With `GEMINI_API_KEY` in `.env` (free from [Google AI Studio](https://aistudio.google.com/apikey)), the sync also asks Gemini 3.8 Flash to read each **tracked** email once and note the role, whether it's a job, internship or competition, and any interview/assessment time or deadline. Emails the confirmation rule ignored are never sent. At most 100 model calls per sync; add `--no-extract` to skip it. If the model stops answering (say the free quota is used up), the sync finishes anyway and reads the rest next time. Measure it with `npm run eval:extract` (16 labelled emails).

Each tracked opportunity is also shown next to your tracker, without changing anything in it:

- **tracker: Backend Engineer at Stripe, applied; emails say interview (not changed)**: linked to one application, and the emails are further along. Use `update_application_status` (with approval) if they're right.
- **2 applications could be this: ...**: several applications at that company and the emails don't say which. Nothing is guessed.
- **not tracked yet**: no application at that company; add it if you want it tracked.

Then **No reply yet** lists the applications with no assessment, interview, offer or rejection, by days since the last email. After 30 days they're marked *ghosted* (`--ghost-days 21` to change it). Ghosted is only a report: it never changes a status and never counts as a rejection. Hackathons and competitions aren't listed.

### Past applications from LinkedIn

Applications older than your inbox, or without a confirmation email, can come from LinkedIn's own export: **Settings → Data privacy → Get a copy of your data**, tick **Job applications**, **Request archive**. LinkedIn emails a download link (it can take up to a day). Unzip it, then:

```bash
npm run linkedin:import -- "C:/Users/you/Downloads/Basic_LinkedInDataExport"
```

Only company, job title, job URL and application date are read into the tracker; contact details, résumé name and screening answers are never stored or printed. Rows you already track are skipped (same company and title, "Stripe Inc." = "Stripe"); a near match ("SDE" vs "SDE Intern" at the same company) is listed for you to decide instead of added. Everything else is added as *applied*, source *LinkedIn*, through the same approval page (up to 100 per page).

### From Claude Desktop

Once Gmail is connected, ask Claude *"check my email for job updates"*: it calls `sync_job_emails` and gets the same report. Claude only sees the organisation, role, category and dates the rules and Gemini took from each email, never a subject, sender or body. Each call reads at most 10 emails with Gemini, so the chat isn't kept waiting; ask again to read more. Then *"apply those updates"* calls `propose_email_updates`: you get one approval with a checkbox per change (in the chat if your client supports it, otherwise the approval page link).

### Apply what the emails show

```bash
npm run gmail:propose
```

This turns the report into tracker changes, using the emails the last sync stored (no Gmail or model calls):

- a status change where the emails are further along (with a note such as *From Gmail: interview email on 2026-10-18* in the history);
- a new application for each confirmed one you don't track yet, dated by its confirmation email, with the job site as its source. If no email named the role it is added as "Role not stated"; fix it later with `update_application`.

Ambiguous ones and competitions are listed as not proposed, with the reason. Nothing changes yet: an approval page opens with one ticked checkbox per change. Untick what you don't want and click **Apply ticked changes** (or **Reject all**). The command waits and prints what happened. The link expires after 15 minutes.

Each change is applied separately inside one transaction: if one no longer fits (you changed that application meanwhile, or it's now a duplicate), only that one is skipped and reported, and the rest are applied.

## Good to know

- **Weekly reconnect:** while the app is in Testing mode, Google expires the saved access after **7 days**. The server then says *"connect Gmail again"*; run `npm run gmail:connect` and you're back.
- **Disconnect:** `npm run gmail:disconnect` revokes the access at Google and deletes the saved token. You can also remove it from <https://myaccount.google.com/permissions>.
- **What is stored:** your address, the granted scopes, and the refresh token encrypted with AES-256-GCM. No passwords, no access tokens. The SELECT-only `mcp_reader` role cannot read this table at all.
