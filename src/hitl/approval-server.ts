import http from "node:http";
import type { AddressInfo } from "node:net";
import { env } from "../config.js";
import { withTransaction } from "../db/tx.js";
import {
  claimPendingAction,
  expireOldPendingActions,
  getPendingAction,
  recordOutcome,
  type PendingActionRow,
} from "../repos/pending-actions.js";
import { ActionError, executeAction } from "./actions.js";
import { tokenMatches } from "./token.js";

// A tiny web page for approving changes when the MCP client has no elicitation support.
//   GET  /approve/<id>?token=...   shows the change, with Approve / Reject buttons
//   POST /approve/<id>             the buttons; only a POST ever changes data
// It listens on 127.0.0.1 only, so nothing outside this computer can reach it.

let port = env.APPROVAL_PORT;

export function approvalUrl(id: string, token: string): string {
  return `http://127.0.0.1:${port}/approve/${id}?token=${token}`;
}

export function startApprovalServer(): Promise<void> {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("approval page: unexpected error", err);
      send(res, 500, page("Something went wrong", "<p>Nothing was changed. Check the server log.</p>"));
    });
  });
  return new Promise((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Claude Desktop and Claude Code can each run a copy of this server. All approval
        // state lives in the database, so the copy that owns the port can serve every link.
        console.error(`approval page: port ${port} in use, another jobhunt-mcp is serving it`);
      } else {
        console.error("approval page: could not start", err);
      }
      resolve();
    });
    server.listen(port, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port; // matters when APPROVAL_PORT=0
      server.unref(); // let the process exit when Claude disconnects
      console.error(`approval page on http://127.0.0.1:${port}`);
      resolve();
    });
  });
}

const ROUTE = /^\/approve\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  // DNS rebinding guard: a malicious website can point its own domain at 127.0.0.1,
  // but the browser still sends that domain as Host. Only accept our own names.
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(req.headers.host ?? "")) return send(res, 403, page("Forbidden", ""));

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const id = ROUTE.exec(url.pathname)?.[1];
  if (!id) return send(res, 404, notFound());

  if (req.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const row = await findWithToken(id, token);
    if (!row) return send(res, 404, notFound());
    return send(res, 200, showAction(row, token));
  }

  if (req.method === "POST") {
    // CSRF guard: a form on another website could POST here; browsers send its Origin.
    const origin = req.headers.origin;
    if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) {
      return send(res, 403, page("Forbidden", ""));
    }
    const form = new URLSearchParams(await readBody(req));
    const row = await findWithToken(id, form.get("token") ?? "");
    if (!row) return send(res, 404, notFound());
    const decision = form.get("decision");
    if (decision === "approve") return send(res, 200, await approve(row));
    if (decision === "reject") return send(res, 200, await reject(row));
    return send(res, 400, page("Bad request", "<p>Unknown decision.</p>"));
  }

  res.setHeader("Allow", "GET, POST");
  return send(res, 405, page("Method not allowed", ""));
}

// Wrong id and wrong token look identical, so the page never confirms an id exists.
async function findWithToken(id: string, token: string): Promise<PendingActionRow | undefined> {
  await expireOldPendingActions();
  const row = await getPendingAction(id);
  return row && token && tokenMatches(token, row.token_hash) ? row : undefined;
}

async function approve(row: PendingActionRow): Promise<string> {
  try {
    // Claim + apply + record in ONE transaction: if applying fails, the claim is undone too.
    const message = await withTransaction(async (client) => {
      const claimed = await claimPendingAction(client, row.id, "approved");
      if (!claimed) return undefined;
      const msg = await executeAction(client, claimed.tool_name, claimed.payload, "user via approval link");
      await recordOutcome(client, row.id, { result: { message: msg } });
      return msg;
    });
    if (message === undefined) return alreadyDecided(row.id);
    return page("Approved", `<p class="ok">${esc(message)}</p><p>You can close this tab and tell Claude it's done.</p>`);
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    // You approved, but the change no longer applies (e.g. it was edited meanwhile).
    // Close the link anyway and keep the reason.
    await withTransaction(async (client) => {
      if (await claimPendingAction(client, row.id, "approved")) {
        await recordOutcome(client, row.id, { error: err.message });
      }
    });
    return page("Could not apply", `<p class="bad">${esc(err.message)}</p><p>Nothing was changed.</p>`);
  }
}

async function reject(row: PendingActionRow): Promise<string> {
  const claimed = await withTransaction((client) => claimPendingAction(client, row.id, "rejected"));
  if (!claimed) return alreadyDecided(row.id);
  return page("Rejected", "<p>Nothing was changed.</p>");
}

async function alreadyDecided(id: string): Promise<string> {
  const row = await getPendingAction(id);
  return page(
    "Already decided",
    `<p>This change is already <strong>${esc(row?.status ?? "gone")}</strong>. Nothing more was done.</p>`,
  );
}

function showAction(row: PendingActionRow, token: string): string {
  const meta = `<p class="meta">${esc(row.tool_name)} · requested ${row.created_at.toISOString()} · expires ${row.expires_at.toISOString()}</p>`;
  if (row.status !== "pending") {
    const outcome = row.error ? `<p class="bad">${esc(row.error)}</p>` : "";
    return page(
      `Already ${row.status}`,
      `<pre>${esc(row.summary)}</pre>${meta}<p>This change is <strong>${esc(row.status)}</strong>.</p>${outcome}`,
    );
  }
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

function notFound(): string {
  return page("Link not found", "<p>This approval link is wrong or incomplete.</p>");
}

// ---------- tiny HTTP + HTML helpers ----------

function send(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", // don't leak the token to other sites
    "X-Frame-Options": "DENY", // no clickjacking via a hidden frame
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
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

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · jobhunt-mcp</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; background: #fafafa; }
  pre { white-space: pre-wrap; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 1rem; font: inherit; }
  .meta { color: #666; font-size: 0.85rem; }
  button { font: inherit; padding: 0.5rem 1.25rem; border-radius: 6px; border: 1px solid #999; background: #fff; cursor: pointer; margin-right: 0.5rem; }
  .approve { background: #1a7f37; border-color: #1a7f37; color: #fff; }
  .ok { color: #1a7f37; } .bad { color: #b42318; }
  @media (prefers-color-scheme: dark) {
    body { background: #161616; color: #eee; } pre { background: #222; border-color: #444; }
    button { background: #222; color: #eee; border-color: #555; } .meta { color: #aaa; }
  }
</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}
