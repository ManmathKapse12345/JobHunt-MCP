import type { Fetch } from "../../src/google/oauth.js";

// Plays Google's token, revoke and Gmail profile endpoints, so tests never touch the network.
// Change `next` to make the next responses fail; read `calls` to see what was sent.
export function fakeGoogle(email = "me@gmail.com") {
  let issued = 0;
  const state = {
    calls: [] as Array<{ url: string; body: Record<string, string>; auth?: string }>,
    next: {
      grantedScope: "https://www.googleapis.com/auth/gmail.readonly",
      refreshToken: "1//refresh-token-from-google" as string | undefined,
      tokenError: undefined as string | undefined, // e.g. "invalid_grant"
      revokeOk: true,
    },
    validAccessTokens: new Set<string>(),
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetch: Fetch = async (input, init) => {
    const url = String(input);
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    state.calls.push({ url, body, auth });

    if (url === "https://oauth2.googleapis.com/token") {
      if (state.next.tokenError) return json(400, { error: state.next.tokenError });
      const accessToken = `ya29.access-${++issued}`;
      state.validAccessTokens.add(accessToken);
      return json(200, {
        access_token: accessToken,
        expires_in: 3599,
        scope: state.next.grantedScope,
        token_type: "Bearer",
        ...(body.grant_type === "authorization_code" && state.next.refreshToken && { refresh_token: state.next.refreshToken }),
      });
    }
    if (url === "https://oauth2.googleapis.com/revoke") return new Response("", { status: state.next.revokeOk ? 200 : 400 });
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      const token = auth?.replace(/^Bearer /, "") ?? "";
      if (!state.validAccessTokens.has(token)) return json(401, { error: { message: "Invalid Credentials" } });
      return json(200, { emailAddress: email, messagesTotal: 1234, historyId: "987654" });
    }
    return json(404, { error: { message: `fake-google: no route for ${url}` } });
  };

  return { fetch, ...state, tokenCalls: () => state.calls.filter((c) => c.url.endsWith("/token")) };
}
