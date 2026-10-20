import http from "node:http";
import type { AddressInfo } from "node:net";
import { page, send } from "../hitl/approval-page.js";
import { secretEquals } from "../hitl/token.js";
import { OAuthError } from "./oauth.js";

// Receives Google's redirect at http://127.0.0.1:<random port>/callback: the loopback flow
// Google recommends for desktop and command-line apps. Listens on 127.0.0.1 only, for one
// redirect, then stops. Any port works: Google accepts every loopback port for a
// "Desktop app" client.

export interface LoopbackReceiver {
  redirectUri: string;
  // Resolves with the code once the browser comes back with the right state.
  code: Promise<string>;
  close: () => void;
}

export async function startLoopbackReceiver(expectedState: string, timeoutMs = 5 * 60_000): Promise<LoopbackReceiver> {
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  code.catch(() => {}); // the caller awaits it; don't count it as unhandled before then

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") return send(res, 404, page("Not found", ""));

    // A redirect we didn't start (or a stale tab): refuse it, keep waiting for the real one.
    if (!secretEquals(url.searchParams.get("state") ?? "", expectedState)) {
      return send(res, 400, page("Wrong sign-in request", "<p>This page doesn't belong to the current connect attempt. Close it.</p>"));
    }
    const error = url.searchParams.get("error");
    if (error) {
      send(res, 200, page("Not connected", "<p>Gmail was not connected. You can close this tab.</p>"));
      return settle.reject(new OAuthError(error === "access_denied" ? "You cancelled on Google's page." : `Google said: ${error}`));
    }
    const got = url.searchParams.get("code");
    if (!got) return send(res, 400, page("Bad request", "<p>No code in the redirect.</p>"));
    send(res, 200, page("Almost done", "<p>Google sent the go-ahead. Return to the terminal; you can close this tab.</p>"));
    settle.resolve(got);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(() => settle.reject(new OAuthError("Timed out waiting for Google (5 minutes).")), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  code.then(close, close);
  return { redirectUri: `http://127.0.0.1:${port}/callback`, code, close };
}
