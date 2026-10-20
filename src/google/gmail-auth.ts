import { env } from "../config.js";
import { open, seal } from "../crypto/secret-box.js";
import { log } from "../log.js";
import {
  deleteGmailConnection,
  getGmailConnection,
  upsertGmailConnection,
  type GmailConnectionRow,
} from "../repos/gmail-connections.js";
import { getProfile } from "./gmail-api.js";
import {
  exchangeCode,
  GMAIL_READONLY,
  OAuthError,
  ReconnectRequired,
  refreshAccessToken,
  revokeToken,
  type Fetch,
  type OAuthClient,
} from "./oauth.js";

// The connected Gmail account: connect, get a working access token, disconnect.
// The refresh token exists in plain text only in memory, for the moment it is used.

export class GmailNotConfigured extends OAuthError {}
export class GmailNotConnected extends OAuthError {}

export interface GmailAuthDeps {
  client: OAuthClient;
  key: Buffer; // TOKEN_ENCRYPTION_KEY
  fetch?: Fetch;
  now?: () => number;
}

const glog = log.child({ component: "gmail" });
// Bound into the ciphertext (AAD): a token copied onto another account's row won't decrypt.
const aad = (email: string) => `gmail_connections:${email.toLowerCase()}`;

export function createGmailAuth(deps: GmailAuthDeps) {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  // Access tokens last an hour: keep one in memory instead of refreshing on every call.
  let cached: { connectionId: string; token: string; expiresAt: number } | undefined;

  const decrypt = (row: GmailConnectionRow) => open(row.refresh_token_enc, deps.key, aad(row.email));

  return {
    // Step 3 of the flow (oauth.ts): the browser came back with a code.
    async completeConnect(opts: { code: string; codeVerifier: string; redirectUri: string }) {
      const tokens = await exchangeCode(fetchFn, deps.client, opts, now());
      // Google's consent screen lets people untick individual permissions.
      if (!tokens.scopes.includes(GMAIL_READONLY)) {
        await revokeToken(fetchFn, tokens.accessToken).catch(() => false);
        throw new OAuthError('Gmail access was not granted. Run connect again and tick "View your email messages and settings".');
      }
      if (!tokens.refreshToken) throw new OAuthError("Google sent no refresh token. Run connect again.");

      const profile = await getProfile(fetchFn, tokens.accessToken);
      const row = await upsertGmailConnection({
        email: profile.emailAddress,
        refreshTokenEnc: seal(tokens.refreshToken, deps.key, aad(profile.emailAddress)),
        scopes: tokens.scopes.join(" "),
      });
      cached = { connectionId: row.id, token: tokens.accessToken, expiresAt: tokens.expiresAt };
      glog.info({ email: row.email, scopes: tokens.scopes }, "gmail connected");
      return { email: row.email, scopes: tokens.scopes };
    },

    // A valid access token for API calls, refreshing it when it is about to expire.
    async accessToken(): Promise<{ token: string; email: string }> {
      const row = await getGmailConnection();
      if (!row) throw new GmailNotConnected("No Gmail account is connected. Run: npm run gmail:connect");
      if (cached?.connectionId === row.id && cached.expiresAt - now() > 60_000) {
        return { token: cached.token, email: row.email };
      }
      try {
        const tokens = await refreshAccessToken(fetchFn, deps.client, decrypt(row), now());
        cached = { connectionId: row.id, token: tokens.accessToken, expiresAt: tokens.expiresAt };
        return { token: tokens.accessToken, email: row.email };
      } catch (err) {
        if (err instanceof ReconnectRequired) {
          glog.warn({ email: row.email }, "gmail grant no longer valid; reconnect needed");
          // Testing-mode Google apps issue refresh tokens that expire after 7 days.
          throw new ReconnectRequired(
            `Google no longer accepts the saved Gmail access for ${row.email} (revoked, or it expired). Run: npm run gmail:connect`,
          );
        }
        throw err;
      }
    },

    async status() {
      const row = await getGmailConnection();
      return row
        ? { connected: true as const, email: row.email, scopes: row.scopes.split(" "), connectedAt: row.connected_at }
        : { connected: false as const };
    },

    // Revoke at Google (best effort) and forget the token here (always).
    async disconnect(): Promise<{ email: string; revoked: boolean } | undefined> {
      const row = await getGmailConnection();
      if (!row) return undefined;
      let revoked = false;
      try {
        revoked = await revokeToken(fetchFn, decrypt(row));
      } catch (err) {
        glog.warn({ err, email: row.email }, "could not revoke at Google; deleting the local token anyway");
      }
      await deleteGmailConnection(row.id);
      cached = undefined;
      glog.info({ email: row.email, revoked }, "gmail disconnected");
      return { email: row.email, revoked };
    },
  };
}

export type GmailAuth = ReturnType<typeof createGmailAuth>;

// From the environment, or a clear explanation of what is missing.
export function gmailAuthFromEnv(): GmailAuth {
  const missing = [
    !env.GOOGLE_CLIENT_ID && "GOOGLE_CLIENT_ID",
    !env.GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET",
    !env.TOKEN_ENCRYPTION_KEY && "TOKEN_ENCRYPTION_KEY",
  ].filter(Boolean);
  if (missing.length > 0 || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) {
    throw new GmailNotConfigured(`Gmail is not set up: ${missing.join(", ")} missing in .env (see docs/gmail-setup.md).`);
  }
  return createGmailAuth({
    client: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    key: env.TOKEN_ENCRYPTION_KEY,
  });
}
