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

## 5. Create the table and connect

1. Run [`supabase/migrations/005_gmail_connections.sql`](../supabase/migrations/005_gmail_connections.sql) in the Supabase SQL editor.
2. Run:

   ```bash
   npm run gmail:connect
   ```

   Your browser opens Google's page. Pick your account. Google warns **"Google hasn't verified this app"**: that's expected for your own app in Testing mode; click **Continue**. Tick **"View your email messages and settings"** and continue.
3. The terminal prints `Connected you@gmail.com (read-only)`. Check any time with `npm run gmail:status`.

To try it without touching your real tracker, add `--demo` (uses the local Docker database): `npm run gmail:connect -- --demo`.

## Good to know

- **Weekly reconnect:** while the app is in Testing mode, Google expires the saved access after **7 days**. The server then says *"connect Gmail again"*; run `npm run gmail:connect` and you're back.
- **Disconnect:** `npm run gmail:disconnect` revokes the access at Google and deletes the saved token. You can also remove it from <https://myaccount.google.com/permissions>.
- **What is stored:** your address, the granted scopes, and the refresh token encrypted with AES-256-GCM. No passwords, no access tokens. The SELECT-only `mcp_reader` role cannot read this table at all.
