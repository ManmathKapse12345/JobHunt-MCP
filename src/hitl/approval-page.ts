import type http from "node:http";
import { isDbUnavailable } from "../db/errors.js";
import { log } from "../log.js";
import type { PendingActionRow } from "../repos/pending-actions.js";
import { type BatchItem, type BatchOutcome, batchItems } from "./actions.js";
import {
  clearedSessionCookie,
  clearLoginFailures,
  loginBlocked,
  newSessionValue,
  readCookie,
  recordLoginFailure,
  SESSION_COOKIE,
  sessionCookie,
  sessionIsValid,
} from "./admin-session.js";
import { type Decision, decide, findWithToken } from "./decide.js";
import { secretEquals } from "./token.js";

// The web page for approving changes when the MCP client has no elicitation support.
//   GET  /approve/<id>?token=...   shows the change, with Approve / Reject buttons
//   POST /approve/<id>             the buttons; only a POST ever changes data
// With an admin token (HTTP mode) you must sign in first:
//   GET/POST /login, POST /logout
// Served by approval-server.ts on 127.0.0.1 (stdio mode) and by http.ts (deployed).

export interface ApprovalPageOptions {
  // Origins the page is reached on, e.g. ["https://jobhunt.onrender.com"]. Requests with
  // any other Host, and POSTs from any other Origin, are refused.
  origins: string[];
  // When set, the page requires signing in with this password.
  adminToken?: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTE = new RegExp(`^/approve/(${UUID})$`);
// Where the sign-in form may send you afterwards: only back to an approval link (no open redirect).
const SAFE_NEXT = new RegExp(`^/approve/${UUID}(\\?token=[A-Za-z0-9_-]{1,128})?$`);

export function isApprovalPath(pathname: string): boolean {
  return pathname.startsWith("/approve/") || pathname === "/login" || pathname === "/logout";
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export function createApprovalHandler(opts: ApprovalPageOptions): Handler {
  const hosts = opts.origins.map((o) => new URL(o).host);
  const secure = opts.origins[0]!.startsWith("https:");
  const admin = opts.adminToken;

  const signedIn = (req: http.IncomingMessage) =>
    admin !== undefined && sessionIsValid(readCookie(req.headers.cookie, SESSION_COOKIE), admin);

  // CSRF guard: a form on another website could POST here; browsers send its Origin.
  // "Origin: null" (sandboxed frames, some redirects) counts as foreign too.
  const foreignOrigin = (req: http.IncomingMessage) =>
    req.headers.origin !== undefined && !opts.origins.includes(req.headers.origin);

  // Sign-out button under every page once signed in.
  const withSignOut = (html: string) =>
    admin ? `${html}<form method="post" action="/logout" class="signout"><button>Sign out</button></form>` : html;

  return async (req, res) => {
    // DNS rebinding guard: a malicious website can point its own domain at our address,
    // but the browser still sends that domain as Host. Only accept our own names.
    if (!hosts.includes(req.headers.host ?? "")) return send(res, 403, page("Forbidden", ""));

    const url = new URL(req.url ?? "/", "http://placeholder");

    if (admin && url.pathname === "/login") return login(req, res, url, admin);
    if (admin && url.pathname === "/logout") return logout(req, res);

    const id = ROUTE.exec(url.pathname)?.[1];
    if (!id) return send(res, 404, notFound());

    if (admin && !signedIn(req)) {
      // Say nothing about the change (not even whether the link is real) before sign-in.
      if (req.method === "GET") {
        const token = url.searchParams.get("token");
        return send(res, 200, loginPage(`/approve/${id}${token ? `?token=${encodeURIComponent(token)}` : ""}`));
      }
      return send(res, 401, loginPage(`/approve/${id}`, "Please sign in, then open the approval link again."));
    }

    if (req.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      const row = await findWithToken(id, token);
      if (!row) return send(res, 404, notFound());
      return send(res, 200, withSignOut(showAction(row, token)));
    }

    if (req.method === "POST") {
      if (foreignOrigin(req)) return send(res, 403, page("Forbidden", ""));
      const form = new URLSearchParams(await readBody(req));
      const row = await findWithToken(id, form.get("token") ?? "");
      if (!row) return send(res, 404, notFound());
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "reject") return send(res, 400, page("Bad request", "<p>Unknown decision.</p>"));
      const ticked = row.tool_name === "apply_batch" ? form.getAll("item").map(Number).filter(Number.isInteger) : undefined;
      return send(res, 200, withSignOut(decisionPage(await decide(row, decision, "user via approval link", ticked))));
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, page("Method not allowed", ""));
  };

  async function login(req: http.IncomingMessage, res: http.ServerResponse, url: URL, adminToken: string) {
    if (req.method === "GET") {
      const next = safeNext(url.searchParams.get("next"));
      if (signedIn(req)) return send(res, 200, withSignOut(page("Signed in", "<p>Open an approval link to review a change.</p>")));
      return send(res, 200, loginPage(next));
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return send(res, 405, page("Method not allowed", ""));
    }
    // Login CSRF: another site must not be able to sign you in (or try passwords) via your browser.
    if (foreignOrigin(req)) return send(res, 403, page("Forbidden", ""));

    const ip = clientIp(req);
    const form = new URLSearchParams(await readBody(req));
    const next = safeNext(form.get("next"));
    if (loginBlocked(ip)) {
      return send(res, 429, loginPage(next, "Too many wrong passwords. Wait 15 minutes and try again."));
    }
    if (!secretEquals(form.get("password") ?? "", adminToken)) {
      recordLoginFailure(ip);
      log.warn({ component: "approval-page", ip }, "failed sign-in");
      return send(res, 401, loginPage(next, "Wrong password."));
    }
    clearLoginFailures(ip);
    // 303 = "now GET this": the browser follows it without re-sending the form.
    res.writeHead(303, {
      Location: next,
      "Set-Cookie": sessionCookie(newSessionValue(adminToken), secure),
      "Cache-Control": "no-store",
    });
    res.end();
  }

  async function logout(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, 405, page("Method not allowed", ""));
    }
    if (foreignOrigin(req)) return send(res, 403, page("Forbidden", ""));
    return send(res, 200, page("Signed out", "<p>You can close this tab.</p>"), {
      "Set-Cookie": clearedSessionCookie(secure),
    });
  }
}

function safeNext(next: string | null): string {
  return next && SAFE_NEXT.test(next) ? next : "/login";
}

// Express (with "trust proxy") puts the real client IP in req.ip; plain node:http does not.
function clientIp(req: http.IncomingMessage): string {
  return (req as { ip?: string }).ip ?? req.socket.remoteAddress ?? "unknown";
}

function decisionPage(d: Decision): string {
  switch (d.kind) {
    case "approved":
      return page(
        "Approved",
        `<p class="ok">${esc(d.message)}</p>${d.items ? outcomeList(d.items) : ""}<p>You can close this tab and tell Claude it's done.</p>`,
      );
    case "rejected":
      return page("Rejected", "<p>Nothing was changed.</p>");
    case "not-applied":
      return page("Could not apply", `<p class="bad">${esc(d.message)}</p><p>Nothing was changed.</p>`);
    case "already":
      return page("Already decided", `<p>This change is already <strong>${esc(d.status)}</strong>. Nothing more was done.</p>`);
  }
}

function outcomeList(items: BatchOutcome[]): string {
  const label = { applied: "Applied", failed: "Not applied", skipped: "Skipped" } as const;
  return `<ul class="items">${items
    .map((it) => `<li><strong class="${it.outcome === "failed" ? "bad" : it.outcome === "applied" ? "ok" : ""}">${label[it.outcome]}</strong> ${esc(it.summary)}${it.outcome === "failed" ? `<br><span class="meta">${esc(it.message)}</span>` : ""}</li>`)
    .join("")}</ul>`;
}

function showAction(row: PendingActionRow, token: string): string {
  const meta = `<p class="meta">${esc(row.tool_name)} · requested ${row.created_at.toISOString()} · expires ${row.expires_at.toISOString()}</p>`;
  if (row.status !== "pending") {
    const items = (row.result as { items?: BatchOutcome[] } | null)?.items;
    const outcome = row.error ? `<p class="bad">${esc(row.error)}</p>` : items ? outcomeList(items) : "";
    return page(
      `Already ${row.status}`,
      `<pre>${esc(row.summary)}</pre>${meta}<p>This change is <strong>${esc(row.status)}</strong>.</p>${outcome}`,
    );
  }
  if (row.tool_name === "apply_batch") return showBatch(row, token, meta);
  return page(
    "Approve this change?",
    `<pre>${esc(row.summary)}</pre>${meta}
     <form method="post" action="/approve/${row.id}">
       <input type="hidden" name="token" value="${esc(token)}">
       <button name="decision" value="approve" class="approve">Approve</button>
       <button name="decision" value="reject">Reject</button>
     </form>`,
  );
}

// Every item ticked to start with; untick what you don't want. Approving with none ticked
// is the same as rejecting.
function showBatch(row: PendingActionRow, token: string, meta: string): string {
  let items: BatchItem[];
  try {
    items = batchItems(row.payload);
  } catch {
    return page("Can't show this change", "<p class=\"bad\">The stored batch is invalid. Reject it and propose it again.</p>");
  }
  const title = row.summary.split("\n")[0]!;
  return page(
    `Approve ${items.length} change${items.length === 1 ? "" : "s"}?`,
    `<p>${esc(title)}</p>${meta}
     <form method="post" action="/approve/${row.id}">
       <input type="hidden" name="token" value="${esc(token)}">
       <ul class="items">${items
         .map(
           (it, i) =>
             `<li><label><input type="checkbox" name="item" value="${i}" checked> <span>${esc(it.summary)}</span></label></li>`,
         )
         .join("")}</ul>
       <button name="decision" value="approve" class="approve">Apply ticked changes</button>
       <button name="decision" value="reject">Reject all</button>
     </form>`,
  );
}

function loginPage(next: string, error?: string): string {
  return page(
    "Sign in to approve",
    `${error ? `<p class="bad">${esc(error)}</p>` : "<p>Changes proposed by the AI wait here for you. Sign in with your admin token.</p>"}
     <form method="post" action="/login">
       <input type="hidden" name="next" value="${esc(next)}">
       <label>Admin token<br><input type="password" name="password" autocomplete="current-password" required autofocus></label>
       <p><button class="approve">Sign in</button></p>
     </form>`,
  );
}

function notFound(): string {
  return page("Link not found", "<p>This approval link is wrong or incomplete.</p>");
}

// The handler threw (both servers call this): log it, and show a page instead of a stack trace.
// Every change is applied in one transaction, so a failure here never leaves half a change.
export function sendFailure(res: http.ServerResponse, err: unknown) {
  const dbDown = isDbUnavailable(err);
  log.error({ component: "approval-page", err, dbUnavailable: dbDown }, "approval page failed");
  if (res.headersSent) return void res.end();
  if (dbDown) {
    return send(
      res,
      503,
      page("Try again in a minute", "<p>The database can't be reached right now. Nothing was changed; reload this page shortly.</p>"),
      { "Retry-After": "60" },
    );
  }
  send(res, 500, page("Something went wrong", "<p>Nothing was changed. Check the server log.</p>"));
}

// ---------- tiny HTTP + HTML helpers ----------

export function send(res: http.ServerResponse, status: number, html: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // Don't leak the token in the URL to other sites. Not "no-referrer": with that, browsers
    // send "Origin: null" on our own form POSTs, and the CSRF check below refuses them.
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY", // no clickjacking via a hidden frame
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(html);
}

function readBody(req: http.IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Summaries contain company names and notes typed by people: always escape them.
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · jobhunt-mcp</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; background: #fafafa; }
  pre { white-space: pre-wrap; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 1rem; font: inherit; }
  .meta { color: #666; font-size: 0.85rem; }
  button { font: inherit; padding: 0.5rem 1.25rem; border-radius: 6px; border: 1px solid #999; background: #fff; cursor: pointer; margin-right: 0.5rem; }
  input[type=password] { font: inherit; padding: 0.5rem; width: 100%; max-width: 24rem; box-sizing: border-box; border: 1px solid #999; border-radius: 6px; }
  .approve { background: #1a7f37; border-color: #1a7f37; color: #fff; }
  .ok { color: #1a7f37; } .bad { color: #b42318; }
  ul.items { list-style: none; padding: 0; } ul.items li { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 0.6rem 0.8rem; margin: 0.4rem 0; white-space: pre-wrap; }
  ul.items label { display: flex; gap: 0.6rem; align-items: baseline; cursor: pointer; }
  .signout { margin-top: 2rem; } .signout button { font-size: 0.85rem; padding: 0.25rem 0.75rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #161616; color: #eee; } pre, ul.items li { background: #222; border-color: #444; }
    button, input[type=password] { background: #222; color: #eee; border-color: #555; } .meta { color: #aaa; }
  }
</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}
